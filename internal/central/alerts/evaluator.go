package alerts

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sort"
	"time"

	"github.com/google/uuid"
	"smoker/internal/central/auth"
	"smoker/internal/central/db"
	"smoker/internal/central/ingest"
	"smoker/internal/central/wshub"
	"smoker/internal/protocol"
)

// QuorumEvalResult is pure domain output used both in production and deterministic unit tests.
type QuorumEvalResult struct {
	BreachingProbes []string
	PeakValue       float64
	QuorumMet       bool
}

// EvaluateTargetQuorum evaluates how many probes violate a rule's threshold over the sample window.
func EvaluateTargetQuorum(
	rule db.AlertRule,
	probeStats map[string]ingest.WindowStats,
) QuorumEvalResult {
	var breaching []string
	var peak float64

	for probeName, st := range probeStats {
		if st.SampleCount == 0 {
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
	store    *db.Store
	cache    *ingest.RollingCache
	hub      *wshub.Hub
	notifier *Notifier
	aesKey   []byte
	now      func() time.Time
}

func NewEvaluator(store *db.Store, cache *ingest.RollingCache, hub *wshub.Hub, notifier *Notifier, aesKey []byte, nowFn func() time.Time) *Evaluator {
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
			for _, p := range probes {
				if p.Status == "offline" {
					continue
				}
				if !target.AssignAllProbes && !assigned[p.ID] {
					continue
				}
				probeStats[p.Name] = e.cache.WindowStats(target.ID, p.ID, window, now)
			}

			res := EvaluateTargetQuorum(rule, probeStats)
			tid := target.ID
			if res.QuorumMet {
				summary := fmt.Sprintf("%s >= %.2f across %d probes (%v)", rule.Metric, rule.ThresholdValue, len(res.BreachingProbes), res.BreachingProbes)
				inc, isNew, err := e.store.UpsertOpenIncident(ctx, rule.ID, &tid, res.BreachingProbes, res.PeakValue, now, summary)
				if err != nil {
					slog.Warn("upsert incident failed", "err", err)
					continue
				}
				shouldNotify := isNew || inc.LastNotifiedAt == nil || now.Sub(*inc.LastNotifiedAt) >= time.Duration(rule.CooldownSec)*time.Second
				if shouldNotify {
					_ = e.store.MarkIncidentNotified(ctx, inc.ID, now)
					e.dispatchAsync(AlertMessage{
						Status:         "FIRING",
						RuleName:       rule.Name,
						TargetName:     target.Name,
						Metric:         rule.Metric,
						Value:          res.PeakValue,
						Threshold:      rule.ThresholdValue,
						QuorumCount:    len(res.BreachingProbes),
						QuorumRequired: rule.QuorumMinProbes,
						AffectedProbes: res.BreachingProbes,
						Summary:        summary,
						Timestamp:      now.Format(time.RFC3339),
					})
					e.hub.BroadcastUI("matrix", protocol.LiveEvent{
						Type:    "incident_update",
						Channel: "matrix",
						Data:    inc,
					})
				}
			} else {
				resolved, err := e.store.ResolveOpenIncident(ctx, rule.ID, &tid, now)
				if err == nil && resolved != nil {
					e.dispatchAsync(AlertMessage{
						Status:         "RESOLVED",
						RuleName:       rule.Name,
						TargetName:     target.Name,
						Metric:         rule.Metric,
						Value:          0,
						Threshold:      rule.ThresholdValue,
						QuorumCount:    0,
						QuorumRequired: rule.QuorumMinProbes,
						AffectedProbes: resolved.AffectedProbes,
						Summary:        fmt.Sprintf("Recovered below threshold %.2f", rule.ThresholdValue),
						Timestamp:      now.Format(time.RFC3339),
					})
					e.hub.BroadcastUI("matrix", protocol.LiveEvent{
						Type:    "incident_update",
						Channel: "matrix",
						Data:    resolved,
					})
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
		summary := fmt.Sprintf("%d probe(s) offline >= %ds: %v", len(offlineNames), rule.DurationSec, offlineNames)
		inc, isNew, err := e.store.UpsertOpenIncident(ctx, rule.ID, nil, offlineNames, maxOfflineSec, now, summary)
		if err != nil {
			return
		}
		if isNew || inc.LastNotifiedAt == nil || now.Sub(*inc.LastNotifiedAt) >= time.Duration(rule.CooldownSec)*time.Second {
			_ = e.store.MarkIncidentNotified(ctx, inc.ID, now)
			e.dispatchAsync(AlertMessage{
				Status:         "FIRING",
				RuleName:       rule.Name,
				TargetName:     "Fleet Probes",
				Metric:         "probe_offline",
				Value:          maxOfflineSec,
				Threshold:      float64(rule.DurationSec),
				QuorumCount:    len(offlineNames),
				QuorumRequired: rule.QuorumMinProbes,
				AffectedProbes: offlineNames,
				Summary:        summary,
				Timestamp:      now.Format(time.RFC3339),
			})
		}
	} else {
		resolved, err := e.store.ResolveOpenIncident(ctx, rule.ID, nil, now)
		if err == nil && resolved != nil {
			e.dispatchAsync(AlertMessage{
				Status:         "RESOLVED",
				RuleName:       rule.Name,
				TargetName:     "Fleet Probes",
				Metric:         "probe_offline",
				QuorumCount:    len(offlineNames),
				QuorumRequired: rule.QuorumMinProbes,
				AffectedProbes: resolved.AffectedProbes,
				Summary:        "Probes back online",
				Timestamp:      now.Format(time.RFC3339),
			})
		}
	}
}

func (e *Evaluator) dispatchAsync(msg AlertMessage) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		channels, err := e.store.ListAlertChannels(ctx)
		if err != nil {
			slog.Warn("list alert channels failed", "err", err)
			return
		}
		for _, ch := range channels {
			if !ch.Enabled {
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
				if err := e.notifier.SendTelegram(ctx, sec.BotToken, sec.ChatID, msg); err != nil {
					slog.Warn("send telegram alert failed", "channel_id", ch.ID, "err", err)
				}
			case "webhook":
				if err := e.notifier.SendWebhook(ctx, sec.WebhookURL, msg); err != nil {
					slog.Warn("send webhook alert failed", "channel_id", ch.ID, "err", err)
				}
			}
		}
	}()
}
