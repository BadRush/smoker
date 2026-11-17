package alerts

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"smoker/internal/central/auth"
	"smoker/internal/central/db"
	"smoker/internal/central/ingest"
	"smoker/internal/central/wshub"
	"smoker/internal/protocol"
)

const (
	DefaultConfirmCritical = 25 * time.Second
	DefaultConfirmWarn     = 60 * time.Second
)

// AlertStore abstracts persistence operations needed by Evaluator.
type AlertStore interface {
	ListAlertRules(ctx context.Context) ([]db.AlertRule, error)
	ListProbes(ctx context.Context) ([]db.Probe, error)
	ListTargets(ctx context.Context) ([]db.Target, error)
	ListAlertChannels(ctx context.Context) ([]db.AlertChannel, error)
	ListOpenIncidents(ctx context.Context) ([]db.Incident, error)
	UpsertOpenIncident(ctx context.Context, ruleID uuid.UUID, targetID *uuid.UUID, affectedProbes []string, peak float64, severity string, now time.Time, summary string) (db.Incident, bool, bool, error)
	ResolveOpenIncident(ctx context.Context, ruleID uuid.UUID, targetID *uuid.UUID, now time.Time) (*db.Incident, error)
	MarkIncidentNotified(ctx context.Context, id uuid.UUID, now time.Time) error
}

// QuorumEvalResult is pure domain output used both in production and deterministic unit tests.
type QuorumEvalResult struct {
	BreachingProbes []string
	PeakValue       float64
	QuorumMet       bool
}

type alertStateKey struct {
	ruleID   uuid.UUID
	targetID uuid.UUID
}

type holddownState struct {
	pendingSince *time.Time
	recoverSince *time.Time
}

// DetermineSeverity maps rule metric and observed peak value to "critical" or "warn".
func DetermineSeverity(metric string, peak float64) string {
	switch metric {
	case "probe_offline":
		return "critical"
	case "loss_pct":
		if peak >= 50 {
			return "critical"
		}
		return "warn"
	default:
		return "warn"
	}
}

// ResolveConfirmDuration returns the anti-blip confirmation wait duration.
// ConfirmSec == 0 uses Smart Auto defaults (25s for critical/DOWN, 60s for warn/intermittent).
func ResolveConfirmDuration(rule db.AlertRule, severity string) time.Duration {
	if rule.ConfirmSec > 0 {
		return time.Duration(rule.ConfirmSec) * time.Second
	}
	if severity == "critical" {
		return DefaultConfirmCritical
	}
	return DefaultConfirmWarn
}

// EvaluateTargetQuorum evaluates how many probes violate a rule's threshold over the sample window.
func EvaluateTargetQuorum(
	rule db.AlertRule,
	probeStats map[string]ingest.WindowStats,
) QuorumEvalResult {
	return EvaluateTargetQuorumWithMinSamples(rule, probeStats, 1)
}

// EvaluateTargetQuorumWithMinSamples enforces a minimum collected sample guard per probe before triggering.
func EvaluateTargetQuorumWithMinSamples(
	rule db.AlertRule,
	probeStats map[string]ingest.WindowStats,
	minSamples int,
) QuorumEvalResult {
	if minSamples < 1 {
		minSamples = 1
	}
	var breaching []string
	var peak float64

	for probeName, st := range probeStats {
		if st.SampleCount == 0 || st.SampleCount < minSamples {
			continue
		}
		var val float64
		switch rule.Metric {
		case "latency_p95":
			val = st.P95Ms
		case "loss_pct":
			val = st.LossPct
		case "jitter":
			val = st.AvgJitterMs
		case "baseline_spike_pct":
			val = st.BaselineSpikePct
		default:
			continue
		}
		if val >= rule.ThresholdValue {
			breaching = append(breaching, probeName)
			if val > peak {
				peak = val
			}
		}
	}
	sort.Strings(breaching)

	return QuorumEvalResult{
		BreachingProbes: breaching,
		PeakValue:       peak,
		QuorumMet:       len(breaching) >= rule.QuorumMinProbes,
	}
}

type Evaluator struct {
	store        AlertStore
	cache        *ingest.RollingCache
	hub          *wshub.Hub
	notifier     *Notifier
	aesKey       []byte
	now          func() time.Time
	syncDispatch bool

	mu     sync.Mutex
	states map[alertStateKey]*holddownState
}

func NewEvaluator(store AlertStore, cache *ingest.RollingCache, hub *wshub.Hub, notifier *Notifier, aesKey []byte, nowFn func() time.Time) *Evaluator {
	if nowFn == nil {
		nowFn = func() time.Time { return time.Now().UTC() }
	}
	return &Evaluator{
		store:    store,
		cache:    cache,
		hub:      hub,
		notifier: notifier,
		aesKey:   aesKey,
		now:      nowFn,
		states:   make(map[alertStateKey]*holddownState),
	}
}

func (e *Evaluator) SetSyncDispatch(sync bool) {
	e.syncDispatch = sync
}

func (e *Evaluator) Run(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := e.EvaluateOnce(ctx); err != nil {
				slog.Warn("alert evaluation cycle failed", "err", err)
			}
		}
	}
}

func (e *Evaluator) stateFor(key alertStateKey) *holddownState {
	e.mu.Lock()
	defer e.mu.Unlock()
	st, ok := e.states[key]
	if !ok {
		st = &holddownState{}
		e.states[key] = st
	}
	return st
}

func (e *Evaluator) pruneStates(active map[alertStateKey]bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	for k := range e.states {
		if !active[k] {
			delete(e.states, k)
		}
	}
}

func (e *Evaluator) EvaluateOnce(ctx context.Context) error {
	rules, err := e.store.ListAlertRules(ctx)
	if err != nil {
		return err
	}
	if len(rules) == 0 {
		e.pruneStates(nil)
		return nil
	}

	probes, err := e.store.ListProbes(ctx)
	if err != nil {
		return err
	}
	targets, err := e.store.ListTargets(ctx)
	if err != nil {
		return err
	}
	openList, err := e.store.ListOpenIncidents(ctx)
	if err != nil {
		return err
	}

	openByKey := make(map[alertStateKey]db.Incident, len(openList))
	for _, inc := range openList {
		tid := uuid.Nil
		if inc.TargetID != nil {
			tid = *inc.TargetID
		}
		openByKey[alertStateKey{ruleID: inc.RuleID, targetID: tid}] = inc
	}

	now := e.now()
	activeKeys := make(map[alertStateKey]bool)

	for _, rule := range rules {
		if !rule.Enabled {
			continue
		}

		if rule.Metric == "probe_offline" {
			key := alertStateKey{ruleID: rule.ID, targetID: uuid.Nil}
			activeKeys[key] = true
			existingOpen, isOpen := openByKey[key]
			e.evalProbeOffline(ctx, rule, probes, key, existingOpen, isOpen, now)
			continue
		}

		for _, target := range targets {
			if !target.Enabled {
				continue
			}
			if rule.TargetID != nil && *rule.TargetID != target.ID {
				continue
			}
			if rule.TargetID == nil && rule.GroupID != nil && (target.GroupID == nil || *target.GroupID != *rule.GroupID) {
				continue
			}

			key := alertStateKey{ruleID: rule.ID, targetID: target.ID}
			activeKeys[key] = true
			existingOpen, isOpen := openByKey[key]

			assigned := make(map[uuid.UUID]bool, len(target.ProbeIDs))
			for _, pid := range target.ProbeIDs {
				assigned[pid] = true
			}

			probeStats := make(map[string]ingest.WindowStats)
			window := time.Duration(rule.DurationSec) * time.Second
			assignedCount := 0
			onlineCount := 0
			reportingCount := 0

			for _, p := range probes {
				if !target.AssignAllProbes && !assigned[p.ID] {
					continue
				}
				assignedCount++
				if p.Status == "offline" {
					continue
				}
				onlineCount++
				ws := e.cache.WindowStats(target.ID, p.ID, window, now)
				if ws.SampleCount > 0 {
					reportingCount++
				}
				probeStats[p.Name] = ws
			}

			effectiveRule := rule
			if rule.TargetID == nil && assignedCount > 0 && assignedCount < effectiveRule.QuorumMinProbes {
				effectiveRule.QuorumMinProbes = assignedCount
			}

			intervalSec := target.IntervalSec
			if intervalSec < 1 {
				intervalSec = 1
			}
			expectedSamples := rule.DurationSec / intervalSec
			minSamples := 3
			if expectedSamples < minSamples {
				minSamples = expectedSamples
				if minSamples < 1 {
					minSamples = 1
				}
			}

			res := EvaluateTargetQuorumWithMinSamples(effectiveRule, probeStats, minSamples)
			tid := target.ID
			e.reconcileIncidentState(ctx, incidentEvalInput{
				rule:            rule,
				targetID:        &tid,
				targetName:      target.Name,
				targetHost:      target.Host,
				key:             key,
				existingOpen:    existingOpen,
				isOpen:          isOpen,
				breached:        res.QuorumMet,
				breachingProbes: res.BreachingProbes,
				peakVal:         res.PeakValue,
				effectiveQuorum: effectiveRule.QuorumMinProbes,
				totalProbes:     onlineCount,
				canResolve:      onlineCount > 0 && reportingCount > 0,
				resolvedSummary: fmt.Sprintf("Connection restored after "),
				now:             now,
			})
		}
	}

	e.pruneStates(activeKeys)
	return nil
}

type incidentEvalInput struct {
	rule            db.AlertRule
	targetID        *uuid.UUID
	targetName      string
	targetHost      string
	key             alertStateKey
	existingOpen    db.Incident
	isOpen          bool
	breached        bool
	breachingProbes []string
	peakVal         float64
	effectiveQuorum int
	totalProbes     int
	canResolve      bool
	resolvedSummary string
	now             time.Time
}

func (e *Evaluator) reconcileIncidentState(ctx context.Context, in incidentEvalInput) {
	st := e.stateFor(in.key)
	now := in.now

	if in.breached {
		// Any recurring breach cancels an in-progress recovery hold-down (anti-flapping).
		st.recoverSince = nil
		severity := DetermineSeverity(in.rule.Metric, in.peakVal)

		startedAt := now
		if !in.isOpen {
			confirmDur := ResolveConfirmDuration(in.rule, severity)
			if st.pendingSince == nil {
				tCopy := now
				st.pendingSince = &tCopy
			}
			if now.Sub(*st.pendingSince) < confirmDur {
				return
			}
			startedAt = *st.pendingSince
		}
		st.pendingSince = nil

		condMsg := AlertMessage{
			Metric:    in.rule.Metric,
			Value:     in.peakVal,
			Threshold: in.rule.ThresholdValue,
		}
		summary := fmt.Sprintf("%s · %s", formatPlainCondition(condMsg), strings.Join(in.breachingProbes, ", "))
		inc, isNew, escalated, err := e.store.UpsertOpenIncident(ctx, in.rule.ID, in.targetID, in.breachingProbes, in.peakVal, severity, startedAt, summary)
		if err != nil {
			slog.Warn("upsert incident failed", "err", err)
			return
		}

		shouldNotify := isNew || escalated
		if !shouldNotify && in.rule.CooldownSec > 0 {
			shouldNotify = inc.LastNotifiedAt == nil || now.Sub(*inc.LastNotifiedAt) >= time.Duration(in.rule.CooldownSec)*time.Second
		}
		if !shouldNotify {
			return
		}

		_ = e.store.MarkIncidentNotified(ctx, inc.ID, now)
		msgStatus := "FIRING"
		if escalated {
			msgStatus = "ESCALATED"
		}
		var elapsedSec int64
		if !isNew {
			elapsedSec = int64(now.Sub(inc.StartedAt).Seconds())
			if elapsedSec < 0 {
				elapsedSec = 0
			}
		}
		e.dispatch(ctx, AlertMessage{
			Status:         msgStatus,
			Severity:       inc.Severity,
			RuleName:       in.rule.Name,
			TargetName:     in.targetName,
			TargetHost:     in.targetHost,
			Metric:         in.rule.Metric,
			Value:          in.peakVal,
			PeakValue:      inc.PeakValue,
			Threshold:      in.rule.ThresholdValue,
			QuorumCount:    len(in.breachingProbes),
			QuorumRequired: in.effectiveQuorum,
			TotalProbes:    in.totalProbes,
			AffectedProbes: in.breachingProbes,
			Summary:        summary,
			StartedAt:      inc.StartedAt.Format(time.RFC3339),
			DurationSec:    elapsedSec,
			Timestamp:      now.Format(time.RFC3339),
			ChannelIDs:     in.rule.ChannelIDs,
		})
		if e.hub != nil && in.targetID != nil {
			e.hub.BroadcastUI("matrix", protocol.LiveEvent{
				Type:    "incident_update",
				Channel: "matrix",
				Data:    inc,
			})
		}
		return
	}

	// Any unconfirmed pending blip resets quietly without alerting or creating DB incidents.
	st.pendingSince = nil

	if !in.canResolve {
		st.recoverSince = nil
		return
	}
	if !in.isOpen {
		st.recoverSince = nil
		return
	}

	recoverDur := time.Duration(in.rule.RecoverSec) * time.Second
	resolveAt := now
	if recoverDur > 0 {
		if st.recoverSince == nil {
			tCopy := now
			st.recoverSince = &tCopy
		}
		if now.Sub(*st.recoverSince) < recoverDur {
			return
		}
		resolveAt = *st.recoverSince
	}
	st.recoverSince = nil

	if resolveAt.Before(in.existingOpen.StartedAt) {
		resolveAt = in.existingOpen.StartedAt
	}
	resolved, err := e.store.ResolveOpenIncident(ctx, in.rule.ID, in.targetID, resolveAt)
	if err != nil || resolved == nil {
		return
	}

	durSec := int64(resolveAt.Sub(resolved.StartedAt).Seconds())
	if durSec < 0 {
		durSec = 0
	}
	e.dispatch(ctx, AlertMessage{
		Status:         "RESOLVED",
		Severity:       "ok",
		RuleName:       in.rule.Name,
		TargetName:     in.targetName,
		TargetHost:     in.targetHost,
		Metric:         in.rule.Metric,
		Value:          resolved.PeakValue,
		PeakValue:      resolved.PeakValue,
		Threshold:      in.rule.ThresholdValue,
		QuorumCount:    len(resolved.AffectedProbes),
		QuorumRequired: in.effectiveQuorum,
		TotalProbes:    in.totalProbes,
		AffectedProbes: resolved.AffectedProbes,
		Summary:        in.resolvedSummary + FormatDurationSLA(durSec),
		StartedAt:      resolved.StartedAt.Format(time.RFC3339),
		ResolvedAt:     resolveAt.Format(time.RFC3339),
		DurationSec:    durSec,
		Timestamp:      now.Format(time.RFC3339),
		ChannelIDs:     in.rule.ChannelIDs,
	})
	if e.hub != nil && in.targetID != nil {
		e.hub.BroadcastUI("matrix", protocol.LiveEvent{
			Type:    "incident_update",
			Channel: "matrix",
			Data:    resolved,
		})
	}
}

func (e *Evaluator) evalProbeOffline(
	ctx context.Context,
	rule db.AlertRule,
	probes []db.Probe,
	key alertStateKey,
	existingOpen db.Incident,
	isOpen bool,
	now time.Time,
) {
	var offlineNames []string
	var maxOfflineSec float64
	for _, p := range probes {
		if p.Status != "offline" {
			continue
		}
		var sec float64
		if p.LastSeenAt != nil {
			sec = now.Sub(*p.LastSeenAt).Seconds()
		} else {
			sec = now.Sub(p.CreatedAt).Seconds()
		}
		if sec >= float64(rule.DurationSec) {
			offlineNames = append(offlineNames, p.Name)
			if sec > maxOfflineSec {
				maxOfflineSec = sec
			}
		}
	}
	sort.Strings(offlineNames)

	e.reconcileIncidentState(ctx, incidentEvalInput{
		rule:            rule,
		targetID:        nil,
		targetName:      "Monitoring Probes",
		key:             key,
		existingOpen:    existingOpen,
		isOpen:          isOpen,
		breached:        len(offlineNames) >= rule.QuorumMinProbes,
		breachingProbes: offlineNames,
		peakVal:         maxOfflineSec,
		effectiveQuorum: rule.QuorumMinProbes,
		totalProbes:     len(probes),
		canResolve:      true,
		resolvedSummary: "Probes back online after ",
		now:             now,
	})
}

func (e *Evaluator) dispatch(ctx context.Context, msg AlertMessage) {
	if e.syncDispatch {
		e.sendToMatchingChannels(ctx, msg)
		return
	}
	go func() {
		dCtx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
		defer cancel()
		e.sendToMatchingChannels(dCtx, msg)
	}()
}

func (e *Evaluator) sendToMatchingChannels(ctx context.Context, msg AlertMessage) {
	channels, err := e.store.ListAlertChannels(ctx)
	if err != nil {
		slog.Warn("list alert channels failed", "err", err)
		return
	}

	var allowed map[uuid.UUID]bool
	if len(msg.ChannelIDs) > 0 {
		allowed = make(map[uuid.UUID]bool, len(msg.ChannelIDs))
		for _, id := range msg.ChannelIDs {
			allowed[id] = true
		}
	}

	for _, ch := range channels {
		if !ch.Enabled {
			continue
		}
		if allowed != nil && !allowed[ch.ID] {
			continue
		}
		plain, err := auth.DecryptAESGCM(e.aesKey, ch.ConfigEncrypted)
		if err != nil {
			slog.Warn("decrypt channel config failed", "channel_id", ch.ID, "err", err)
			continue
		}
		var sec ChannelSecret
		if err := json.Unmarshal(plain, &sec); err != nil {
			continue
		}
		switch ch.Type {
		case "telegram":
			if err := e.notifier.SendTelegram(ctx, sec.BotToken, sec.ChatID, sec.ThreadID, msg); err != nil {
				slog.Warn("send telegram alert failed", "channel_id", ch.ID, "err", err)
			}
		case "webhook":
			if err := e.notifier.SendWebhook(ctx, sec.WebhookURL, msg); err != nil {
				slog.Warn("send webhook alert failed", "channel_id", ch.ID, "err", err)
			}
		}
	}
}
