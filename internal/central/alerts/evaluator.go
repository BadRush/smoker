package alerts

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
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
	MarkIncidentNotified(ctx context.Context, id uuid.UUID, notifiedSeverity string, now time.Time, telegramMsgIDs map[string]int64) error
}

// MTRSnapshotStore is an optional extension implemented by db.Store to enrich alerts with bottleneck hops.
type MTRSnapshotStore interface {
	ListMTRSnapshots(ctx context.Context, targetID uuid.UUID, limit int) ([]db.MTRSnapshot, error)
}

// QuorumEvalResult is pure domain output used both in production and deterministic unit tests.
type QuorumEvalResult struct {
	BreachingProbes    []string
	ProbeBreakdown     []ProbeAlertStat
	PeakValue          float64
	EffectiveThreshold float64
	QuorumMet          bool
}

// ResolveProbeWarnMs computes the effective latency warning threshold (ms) for a (Target, Probe) pair
// matching the priority chain used in RollingCache.BuildMatrixCells:
// probe latency override -> target latency_warn_ms -> dynamic Best-Path P25 (max(P25*2, P25+15)) -> timeout_ms * 0.5.
func ResolveProbeWarnMs(target db.Target, probeID uuid.UUID, ws ingest.WindowStats) float64 {
	if target.ProbeLatencyOverrides != nil {
		if ov, ok := target.ProbeLatencyOverrides[probeID.String()]; ok && ov > 0 {
			return float64(ov)
		}
	}
	if target.LatencyWarnMs > 0 {
		return float64(target.LatencyWarnMs)
	}
	if ws.BaselineMs > 0 {
		return math.Round(math.Max(ws.BaselineMs*2.0, ws.BaselineMs+15.0)*100) / 100
	}
	timeout := target.TimeoutMs
	if timeout <= 0 {
		timeout = 1000
	}
	return math.Round(float64(timeout)*0.5*100) / 100
}

type alertStateKey struct {
	ruleID   uuid.UUID
	targetID uuid.UUID
}

type holddownState struct {
	pendingSince  *time.Time
	escalateSince *time.Time
	recoverSince  *time.Time
	inFlight      bool
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

// EvaluateTargetQuorumWithMinSamples enforces a minimum collected sample guard per probe before triggering
// and adaptively clamps required quorum when only 1 active probe is present.
func EvaluateTargetQuorumWithMinSamples(
	rule db.AlertRule,
	probeStats map[string]ingest.WindowStats,
	minSamples int,
) QuorumEvalResult {
	return evaluateTargetQuorumWithThresholds(rule, probeStats, minSamples, nil)
}

func evaluateTargetQuorumWithThresholds(
	rule db.AlertRule,
	probeStats map[string]ingest.WindowStats,
	minSamples int,
	perProbeThresholds map[string]float64,
) QuorumEvalResult {
	if minSamples < 1 {
		minSamples = 1
	}
	var breaching []string
	var peak float64
	var effThresh float64
	statByProbe := make(map[string]ProbeAlertStat)

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

		threshold := rule.ThresholdValue
		if perProbeThresholds != nil && rule.Metric == "latency_p95" && threshold <= 0 {
			if overrideThresh, ok := perProbeThresholds[probeName]; ok && overrideThresh > 0 {
				threshold = overrideThresh
			}
		}

		if val >= threshold {
			breaching = append(breaching, probeName)
			statByProbe[probeName] = ProbeAlertStat{
				ProbeName:        probeName,
				LossPct:          st.LossPct,
				P95Ms:            st.P95Ms,
				AvgJitterMs:      st.AvgJitterMs,
				BaselineMs:       st.BaselineMs,
				BaselineSpikePct: st.BaselineSpikePct,
			}
			if val > peak {
				peak = val
			}
			if threshold > effThresh {
				effThresh = threshold
			}
		}
	}
	sort.Strings(breaching)
	breakdown := make([]ProbeAlertStat, 0, len(breaching))
	for _, name := range breaching {
		breakdown = append(breakdown, statByProbe[name])
	}

	effectiveQuorum := rule.QuorumMinProbes
	if len(probeStats) > 0 && len(probeStats) < effectiveQuorum {
		effectiveQuorum = len(probeStats)
	}
	if effectiveQuorum < 1 {
		effectiveQuorum = 1
	}
	if effThresh <= 0 {
		effThresh = rule.ThresholdValue
	}

	return QuorumEvalResult{
		BreachingProbes:    breaching,
		ProbeBreakdown:     breakdown,
		PeakValue:          peak,
		EffectiveThreshold: effThresh,
		QuorumMet:          len(breaching) >= effectiveQuorum,
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

func (e *Evaluator) isInFlight(key alertStateKey) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	if st, ok := e.states[key]; ok {
		return st.inFlight
	}
	return false
}

func (e *Evaluator) tryAcquireDispatch(key alertStateKey) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	st, ok := e.states[key]
	if !ok {
		st = &holddownState{}
		e.states[key] = st
	}
	if st.inFlight {
		return false
	}
	st.inFlight = true
	return true
}

func (e *Evaluator) releaseDispatch(key alertStateKey) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if st, ok := e.states[key]; ok {
		st.inFlight = false
	}
}

func (e *Evaluator) pruneStates(active map[alertStateKey]bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	for k, st := range e.states {
		if !active[k] && !st.inFlight {
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
			var perProbeThresholds map[string]float64
			useAutoBestPath := rule.Metric == "latency_p95" && rule.ThresholdValue <= 0
			if useAutoBestPath {
				perProbeThresholds = make(map[string]float64)
			}
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
				if useAutoBestPath {
					perProbeThresholds[p.Name] = ResolveProbeWarnMs(target, p.ID, ws)
				}
			}

			effectiveRule := rule
			if onlineCount > 0 && onlineCount < effectiveRule.QuorumMinProbes {
				effectiveRule.QuorumMinProbes = onlineCount
			} else if onlineCount == 0 && assignedCount > 0 && assignedCount < effectiveRule.QuorumMinProbes {
				effectiveRule.QuorumMinProbes = assignedCount
			}
			if effectiveRule.QuorumMinProbes < 1 {
				effectiveRule.QuorumMinProbes = 1
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

			res := evaluateTargetQuorumWithThresholds(effectiveRule, probeStats, minSamples, perProbeThresholds)
			tid := target.ID
			isMuted := target.MutedUntil != nil && now.Before(*target.MutedUntil)
			e.reconcileIncidentState(ctx, incidentEvalInput{
				rule:            rule,
				targetID:        &tid,
				targetName:      target.Name,
				targetHost:      target.Host,
				muted:           isMuted,
				key:             key,
				existingOpen:    existingOpen,
				isOpen:          isOpen,
				breached:        res.QuorumMet,
				breachingProbes: res.BreachingProbes,
				probeBreakdown:  res.ProbeBreakdown,
				peakVal:         res.PeakValue,
				effectiveThresh: res.EffectiveThreshold,
				effectiveQuorum: effectiveRule.QuorumMinProbes,
				totalProbes:     onlineCount,
				canResolve:      onlineCount > 0 && reportingCount > 0,
				resolvedSummary: "Connection restored after ",
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
	muted           bool
	key             alertStateKey
	existingOpen    db.Incident
	isOpen          bool
	breached        bool
	breachingProbes []string
	probeBreakdown  []ProbeAlertStat
	peakVal         float64
	effectiveThresh float64
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

		if in.muted {
			if !in.isOpen {
				st.pendingSince = nil
				st.escalateSince = nil
				return
			}
			return
		}

		severity := DetermineSeverity(in.rule.Metric, in.peakVal)
		currentVal := in.peakVal
		upsertPeak := in.peakVal

		startedAt := now
		if !in.isOpen {
			st.escalateSince = nil
			confirmDur := ResolveConfirmDuration(in.rule, severity)
			if st.pendingSince == nil {
				tCopy := now
				st.pendingSince = &tCopy
			}
			if now.Sub(*st.pendingSince) < confirmDur {
				return
			}
			startedAt = *st.pendingSince
		} else if in.existingOpen.Severity == "warn" && severity == "critical" {
			confirmDur := ResolveConfirmDuration(in.rule, "critical")
			if confirmDur > 0 {
				if st.escalateSince == nil {
					tCopy := now
					st.escalateSince = &tCopy
				}
				if now.Sub(*st.escalateSince) < confirmDur {
					// Hold down critical escalation until confirmed; keep open incident as warn.
					severity = "warn"
					upsertPeak = in.existingOpen.PeakValue
					if currentVal < 50 && currentVal > upsertPeak {
						upsertPeak = currentVal
					}
					if in.existingOpen.LastNotifiedAt != nil &&
						(in.rule.CooldownSec == 0 || in.existingOpen.AcknowledgedAt != nil || now.Sub(*in.existingOpen.LastNotifiedAt) < time.Duration(in.rule.CooldownSec)*time.Second) {
						return
					}
					currentVal = upsertPeak
				} else if !e.syncDispatch && e.isInFlight(in.key) {
					return
				} else {
					st.escalateSince = nil
				}
			}
		} else {
			st.escalateSince = nil
		}

		if !e.syncDispatch && e.isInFlight(in.key) {
			return
		}
		st.pendingSince = nil

		msgThresh := in.effectiveThresh
		if msgThresh <= 0 {
			msgThresh = in.rule.ThresholdValue
		}

		condMsg := AlertMessage{
			Metric:    in.rule.Metric,
			Value:     currentVal,
			Threshold: msgThresh,
		}
		summary := fmt.Sprintf("%s · %s", formatPlainCondition(condMsg), strings.Join(in.breachingProbes, ", "))
		inc, isNew, escalated, err := e.store.UpsertOpenIncident(ctx, in.rule.ID, in.targetID, in.breachingProbes, upsertPeak, severity, startedAt, summary)
		if err != nil {
			slog.Warn("upsert incident failed", "err", err)
			return
		}

		needsInitial := isNew || inc.LastNotifiedAt == nil
		needsEscalation := !needsInitial && (escalated || (inc.Severity == "critical" && inc.NotifiedSeverity != "critical"))
		needsReminder := !needsInitial && !needsEscalation &&
			in.rule.CooldownSec > 0 &&
			inc.AcknowledgedAt == nil &&
			(inc.LastNotifiedAt == nil || now.Sub(*inc.LastNotifiedAt) >= time.Duration(in.rule.CooldownSec)*time.Second)

		shouldNotify := needsInitial || needsEscalation || needsReminder
		if !shouldNotify {
			return
		}

		msgStatus := "FIRING"
		if needsEscalation {
			msgStatus = "ESCALATED"
		}
		var elapsedSec int64
		if !isNew && (needsEscalation || needsReminder) {
			elapsedSec = int64(now.Sub(inc.StartedAt).Seconds())
			if elapsedSec < 0 {
				elapsedSec = 0
			}
		}

		var mtrBottleneck string
		if in.targetID != nil {
			if mtrStore, ok := e.store.(MTRSnapshotStore); ok {
				if snaps, err := mtrStore.ListMTRSnapshots(ctx, *in.targetID, 5); err == nil && len(snaps) > 0 {
					mtrBottleneck = SummarizeMTRBottleneck(snaps, inc.StartedAt)
				}
			}
		}

		replyMap := make(map[string]int64, len(inc.TelegramMessageIDs))
		for k, v := range inc.TelegramMessageIDs {
			replyMap[k] = v
		}

		e.dispatch(ctx, in.key, now, needsInitial && !isNew, AlertMessage{
			IncidentID:       inc.ID,
			IncidentSeverity: inc.Severity,
			Status:           msgStatus,
			Severity:         inc.Severity,
			RuleName:         in.rule.Name,
			TargetName:       in.targetName,
			TargetHost:       in.targetHost,
			Metric:           in.rule.Metric,
			Value:            currentVal,
			PeakValue:        inc.PeakValue,
			Threshold:        msgThresh,
			QuorumCount:      len(in.breachingProbes),
			QuorumRequired:   in.effectiveQuorum,
			TotalProbes:      in.totalProbes,
			AffectedProbes:   in.breachingProbes,
			ProbeBreakdown:   in.probeBreakdown,
			MTRBottleneck:    mtrBottleneck,
			ReplyToByChannel: replyMap,
			Summary:          summary,
			StartedAt:        inc.StartedAt.Format(time.RFC3339),
			DurationSec:      elapsedSec,
			Timestamp:        now.Format(time.RFC3339),
			ChannelIDs:       in.rule.ChannelIDs,
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
	st.escalateSince = nil

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
	if !e.syncDispatch && e.isInFlight(in.key) {
		return
	}
	st.recoverSince = nil

	if resolveAt.Before(in.existingOpen.StartedAt) {
		resolveAt = in.existingOpen.StartedAt
	}
	resolved, err := e.store.ResolveOpenIncident(ctx, in.rule.ID, in.targetID, resolveAt)
	if err != nil || resolved == nil {
		return
	}

	wasNotified := resolved.LastNotifiedAt != nil || len(resolved.TelegramMessageIDs) > 0
	if wasNotified {
		durSec := int64(resolveAt.Sub(resolved.StartedAt).Seconds())
		if durSec < 0 {
			durSec = 0
		}
		replyMap := make(map[string]int64, len(resolved.TelegramMessageIDs))
		for k, v := range resolved.TelegramMessageIDs {
			replyMap[k] = v
		}
		e.dispatch(ctx, in.key, now, false, AlertMessage{
			IncidentID:         resolved.ID,
			IncidentSeverity:   resolved.Severity,
			PartialInitialOnly: resolved.LastNotifiedAt == nil,
			Status:             "RESOLVED",
			Severity:           "ok",
			RuleName:           in.rule.Name,
			TargetName:         in.targetName,
			TargetHost:         in.targetHost,
			Metric:             in.rule.Metric,
			Value:              in.peakVal,
			PeakValue:          resolved.PeakValue,
			Threshold:          in.rule.ThresholdValue,
			QuorumCount:        len(resolved.AffectedProbes),
			QuorumRequired:     in.effectiveQuorum,
			TotalProbes:        in.totalProbes,
			AffectedProbes:     resolved.AffectedProbes,
			ReplyToByChannel:   replyMap,
			Summary:            in.resolvedSummary + FormatDurationSLA(durSec),
			StartedAt:          resolved.StartedAt.Format(time.RFC3339),
			ResolvedAt:         resolveAt.Format(time.RFC3339),
			DurationSec:        durSec,
			Timestamp:          now.Format(time.RFC3339),
			ChannelIDs:         in.rule.ChannelIDs,
		})
	}
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
	statByProbe := make(map[string]ProbeAlertStat)
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
			statByProbe[p.Name] = ProbeAlertStat{
				ProbeName:  p.Name,
				OfflineSec: sec,
			}
			if sec > maxOfflineSec {
				maxOfflineSec = sec
			}
		}
	}
	sort.Strings(offlineNames)
	breakdown := make([]ProbeAlertStat, 0, len(offlineNames))
	for _, name := range offlineNames {
		breakdown = append(breakdown, statByProbe[name])
	}

	effectiveQuorum := rule.QuorumMinProbes
	if len(probes) > 0 && len(probes) < effectiveQuorum {
		effectiveQuorum = len(probes)
	}
	if effectiveQuorum < 1 {
		effectiveQuorum = 1
	}

	e.reconcileIncidentState(ctx, incidentEvalInput{
		rule:            rule,
		targetID:        nil,
		targetName:      "Monitoring Probes",
		key:             key,
		existingOpen:    existingOpen,
		isOpen:          isOpen,
		breached:        len(offlineNames) >= effectiveQuorum,
		breachingProbes: offlineNames,
		probeBreakdown:  breakdown,
		peakVal:         maxOfflineSec,
		effectiveQuorum: effectiveQuorum,
		totalProbes:     len(probes),
		canResolve:      true,
		resolvedSummary: "Probes back online after ",
		now:             now,
	})
}

func (e *Evaluator) dispatch(ctx context.Context, key alertStateKey, now time.Time, isInitialRetry bool, msg AlertMessage) {
	if e.syncDispatch {
		e.sendToMatchingChannels(ctx, now, isInitialRetry, msg)
		return
	}
	if !e.tryAcquireDispatch(key) {
		return
	}
	go func() {
		defer e.releaseDispatch(key)
		dCtx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		defer cancel()
		e.sendToMatchingChannels(dCtx, now, isInitialRetry, msg)
	}()
}

func channelHasPriorDelivery(msg AlertMessage, chKey string) bool {
	if msg.ReplyToByChannel == nil {
		return false
	}
	return msg.ReplyToByChannel[chKey] > 0 ||
		msg.ReplyToByChannel["fired:"+chKey] > 0 ||
		msg.ReplyToByChannel["esc:"+chKey] > 0
}

func channelAcceptsAlert(ch db.AlertChannel, msg AlertMessage) bool {
	if msg.Status == "TEST" || msg.Severity == "test" {
		return true
	}
	chKey := ch.ID.String()
	if (msg.Status == "RESOLVED" || msg.Severity == "ok") && msg.PartialInitialOnly {
		return channelHasPriorDelivery(msg, chKey)
	}
	filter := strings.ToLower(strings.TrimSpace(ch.SeverityFilter))
	if filter != "critical" {
		return true
	}
	if msg.Status == "RESOLVED" || msg.Severity == "ok" {
		if channelHasPriorDelivery(msg, chKey) {
			return true
		}
		if msg.IncidentSeverity != "" {
			return msg.IncidentSeverity == "critical"
		}
		return DetermineSeverity(msg.Metric, msg.PeakValue) == "critical"
	}
	return resolveEffectiveSeverity(msg) == "critical"
}

func (e *Evaluator) sendToMatchingChannels(ctx context.Context, now time.Time, isInitialRetry bool, msg AlertMessage) {
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

	sevLevel := int64(1)
	if resolveEffectiveSeverity(msg) == "critical" {
		sevLevel = 2
	}

	newMsgIDs := make(map[string]int64)
	failed := 0

	for _, ch := range channels {
		if !ch.Enabled {
			continue
		}
		if allowed != nil && !allowed[ch.ID] {
			continue
		}
		if !channelAcceptsAlert(ch, msg) {
			continue
		}
		chKey := ch.ID.String()
		firedKey := "fired:" + chKey
		escKey := "esc:" + chKey
		sevKey := "sev:" + chKey
		var replyToID, firedDone, escDone, sevDone int64
		if msg.ReplyToByChannel != nil {
			replyToID = msg.ReplyToByChannel[chKey]
			firedDone = msg.ReplyToByChannel[firedKey]
			escDone = msg.ReplyToByChannel[escKey]
			sevDone = msg.ReplyToByChannel[sevKey]
		}
		perChMsg := msg
		// If retrying an initial FIRING alert that already succeeded on this channel, skip duplicate send
		// unless severity escalated from warn -> critical before all channels succeeded.
		if isInitialRetry && msg.Status == "FIRING" && (replyToID > 0 || firedDone > 0) {
			if sevLevel <= 1 || sevDone >= 2 {
				continue
			}
			perChMsg.Status = "ESCALATED"
		}
		// If retrying an ESCALATED alert that already succeeded on this channel, skip duplicate send.
		if perChMsg.Status == "ESCALATED" && (escDone > 0 || sevDone >= 2) {
			continue
		}

		plain, err := auth.DecryptAESGCM(e.aesKey, ch.ConfigEncrypted)
		if err != nil {
			slog.Warn("decrypt channel config failed", "channel_id", ch.ID, "err", err)
			failed++
			continue
		}
		var sec ChannelSecret
		if err := json.Unmarshal(plain, &sec); err != nil {
			failed++
			continue
		}

		var sendErr error
		switch ch.Type {
		case "telegram":
			// Only thread onto existing message when this is a follow-up (ESCALATED, reminder, or RESOLVED).
			effectiveReplyID := replyToID
			if perChMsg.Status == "FIRING" && perChMsg.DurationSec == 0 {
				effectiveReplyID = 0
			}
			var sentID int64
			sentID, sendErr = e.notifier.SendTelegramWithReply(ctx, sec.BotToken, sec.ChatID, sec.ThreadID, effectiveReplyID, perChMsg)
			if sendErr == nil && sentID > 0 && replyToID == 0 && perChMsg.Status != "RESOLVED" {
				newMsgIDs[chKey] = sentID
			}
		case "webhook":
			sendErr = e.notifier.SendWebhook(ctx, sec.WebhookURL, perChMsg)
		default:
			continue
		}

		if sendErr != nil {
			slog.Warn("send alert failed", "channel_type", ch.Type, "channel_id", ch.ID, "err", sendErr)
			failed++
			continue
		}
		if perChMsg.Status == "FIRING" {
			newMsgIDs[firedKey] = 1
		} else if perChMsg.Status == "ESCALATED" {
			newMsgIDs[escKey] = 1
		}
		if perChMsg.Status != "RESOLVED" && sevLevel > sevDone {
			newMsgIDs[sevKey] = sevLevel
		}
	}

	if msg.IncidentID != uuid.Nil && msg.Status != "RESOLVED" {
		merged := make(map[string]int64)
		for k, v := range msg.ReplyToByChannel {
			merged[k] = v
		}
		for k, v := range newMsgIDs {
			merged[k] = v
		}
		if failed == 0 {
			_ = e.store.MarkIncidentNotified(ctx, msg.IncidentID, msg.Severity, now, merged)
		} else if len(newMsgIDs) > 0 {
			_ = e.store.MarkIncidentNotified(ctx, msg.IncidentID, "", time.Time{}, merged)
		}
	}
}
