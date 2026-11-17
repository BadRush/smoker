package alerts

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"smoker/internal/central/auth"
	"smoker/internal/central/db"
	"smoker/internal/central/ingest"
	"smoker/internal/central/wshub"
	"smoker/internal/protocol"
)

// AlertStore abstracts persistence operations needed by Evaluator.
type AlertStore interface {
	ListAlertRules(ctx context.Context) ([]db.AlertRule, error)
	ListProbes(ctx context.Context) ([]db.Probe, error)
	ListTargets(ctx context.Context) ([]db.Target, error)
	ListAlertChannels(ctx context.Context) ([]db.AlertChannel, error)
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

func (e *Evaluator) EvaluateOnce(ctx context.Context) error {
	rules, err := e.store.ListAlertRules(ctx)
	if err != nil {
		return err
	}
	if len(rules) == 0 {
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

	now := e.now()

	for _, rule := range rules {
		if !rule.Enabled {
			continue
		}

		if rule.Metric == "probe_offline" {
			e.evalProbeOffline(ctx, rule, probes, now)
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
				st := e.cache.WindowStats(target.ID, p.ID, window, now)
				if st.SampleCount > 0 {
					reportingCount++
				}
				probeStats[p.Name] = st
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
			if res.QuorumMet {
				severity := DetermineSeverity(rule.Metric, res.PeakValue)
				tempMsg := AlertMessage{
					Metric:    rule.Metric,
					Value:     res.PeakValue,
					Threshold: rule.ThresholdValue,
				}
				summary := fmt.Sprintf("%s · %s", formatPlainCondition(tempMsg), strings.Join(res.BreachingProbes, ", "))
				inc, isNew, escalated, err := e.store.UpsertOpenIncident(ctx, rule.ID, &tid, res.BreachingProbes, res.PeakValue, severity, now, summary)
				if err != nil {
					slog.Warn("upsert incident failed", "err", err)
					continue
				}

				shouldNotify := isNew || escalated
				if !shouldNotify && rule.CooldownSec > 0 {
					shouldNotify = inc.LastNotifiedAt == nil || now.Sub(*inc.LastNotifiedAt) >= time.Duration(rule.CooldownSec)*time.Second
				}
				if shouldNotify {
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
						RuleName:       rule.Name,
						TargetName:     target.Name,
						TargetHost:     target.Host,
						Metric:         rule.Metric,
						Value:          res.PeakValue,
						PeakValue:      inc.PeakValue,
						Threshold:      rule.ThresholdValue,
						QuorumCount:    len(res.BreachingProbes),
						QuorumRequired: effectiveRule.QuorumMinProbes,
						TotalProbes:    onlineCount,
						AffectedProbes: res.BreachingProbes,
						Summary:        summary,
						StartedAt:      inc.StartedAt.Format(time.RFC3339),
						DurationSec:    elapsedSec,
						Timestamp:      now.Format(time.RFC3339),
						ChannelIDs:     rule.ChannelIDs,
					})
					if e.hub != nil {
						e.hub.BroadcastUI("matrix", protocol.LiveEvent{
							Type:    "incident_update",
							Channel: "matrix",
							Data:    inc,
						})
					}
				}
			} else {
				// Do not falsely mark an open incident as restored when all assigned probes are offline
				// or none have reported samples yet (e.g., immediately after Central startup).
				if onlineCount == 0 || reportingCount == 0 {
					continue
				}
				resolved, err := e.store.ResolveOpenIncident(ctx, rule.ID, &tid, now)
				if err == nil && resolved != nil {
					durSec := int64(now.Sub(resolved.StartedAt).Seconds())
					if durSec < 0 {
						durSec = 0
					}
					e.dispatch(ctx, AlertMessage{
						Status:         "RESOLVED",
						Severity:       "ok",
						RuleName:       rule.Name,
						TargetName:     target.Name,
						TargetHost:     target.Host,
						Metric:         rule.Metric,
						Value:          resolved.PeakValue,
						PeakValue:      resolved.PeakValue,
						Threshold:      rule.ThresholdValue,
						QuorumCount:    len(resolved.AffectedProbes),
						QuorumRequired: effectiveRule.QuorumMinProbes,
						TotalProbes:    onlineCount,
						AffectedProbes: resolved.AffectedProbes,
						Summary:        fmt.Sprintf("Connection restored after %s", FormatDurationSLA(durSec)),
						StartedAt:      resolved.StartedAt.Format(time.RFC3339),
						ResolvedAt:     now.Format(time.RFC3339),
						DurationSec:    durSec,
						Timestamp:      now.Format(time.RFC3339),
						ChannelIDs:     rule.ChannelIDs,
					})
					if e.hub != nil {
						e.hub.BroadcastUI("matrix", protocol.LiveEvent{
							Type:    "incident_update",
							Channel: "matrix",
							Data:    resolved,
						})
					}
				}
			}
		}
	}

	return nil
}

func (e *Evaluator) evalProbeOffline(ctx context.Context, rule db.AlertRule, probes []db.Probe, now time.Time) {
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

	if len(offlineNames) >= rule.QuorumMinProbes {
		summary := fmt.Sprintf("Monitoring Probe Offline (offline %s) · %s", formatDurationCompact(int64(maxOfflineSec)), strings.Join(offlineNames, ", "))
		inc, isNew, escalated, err := e.store.UpsertOpenIncident(ctx, rule.ID, nil, offlineNames, maxOfflineSec, "critical", now, summary)
		if err != nil {
			return
		}
		shouldNotify := isNew || escalated
		if !shouldNotify && rule.CooldownSec > 0 {
			shouldNotify = inc.LastNotifiedAt == nil || now.Sub(*inc.LastNotifiedAt) >= time.Duration(rule.CooldownSec)*time.Second
		}
		if shouldNotify {
			_ = e.store.MarkIncidentNotified(ctx, inc.ID, now)
			var elapsedSec int64
			if !isNew {
				elapsedSec = int64(now.Sub(inc.StartedAt).Seconds())
				if elapsedSec < 0 {
					elapsedSec = 0
				}
			}
			e.dispatch(ctx, AlertMessage{
				Status:         "FIRING",
				Severity:       "critical",
				RuleName:       rule.Name,
				TargetName:     "Monitoring Probes",
				Metric:         "probe_offline",
				Value:          maxOfflineSec,
				PeakValue:      inc.PeakValue,
				Threshold:      float64(rule.DurationSec),
				QuorumCount:    len(offlineNames),
				QuorumRequired: rule.QuorumMinProbes,
				TotalProbes:    len(probes),
				AffectedProbes: offlineNames,
				Summary:        summary,
				StartedAt:      inc.StartedAt.Format(time.RFC3339),
				DurationSec:    elapsedSec,
				Timestamp:      now.Format(time.RFC3339),
				ChannelIDs:     rule.ChannelIDs,
			})
		}
	} else {
		resolved, err := e.store.ResolveOpenIncident(ctx, rule.ID, nil, now)
		if err == nil && resolved != nil {
			durSec := int64(now.Sub(resolved.StartedAt).Seconds())
			if durSec < 0 {
				durSec = 0
			}
			e.dispatch(ctx, AlertMessage{
				Status:         "RESOLVED",
				Severity:       "ok",
				RuleName:       rule.Name,
				TargetName:     "Monitoring Probes",
				Metric:         "probe_offline",
				Value:          resolved.PeakValue,
				PeakValue:      resolved.PeakValue,
				Threshold:      float64(rule.DurationSec),
				QuorumCount:    len(resolved.AffectedProbes),
				QuorumRequired: rule.QuorumMinProbes,
				TotalProbes:    len(probes),
				AffectedProbes: resolved.AffectedProbes,
				Summary:        fmt.Sprintf("Probes back online after %s", FormatDurationSLA(durSec)),
				StartedAt:      resolved.StartedAt.Format(time.RFC3339),
				ResolvedAt:     now.Format(time.RFC3339),
				DurationSec:    durSec,
				Timestamp:      now.Format(time.RFC3339),
				ChannelIDs:     rule.ChannelIDs,
			})
		}
	}
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
