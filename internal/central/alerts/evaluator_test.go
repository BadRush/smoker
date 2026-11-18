package alerts

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"smoker/internal/central/auth"
	"smoker/internal/central/db"
	"smoker/internal/central/ingest"
	"smoker/internal/protocol"
)

func TestEvaluateTargetQuorum(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name       string
		rule       db.AlertRule
		stats      map[string]ingest.WindowStats
		wantQuorum bool
		wantCount  int
	}{
		{
			name: "single probe failure does not trigger quorum=2 when 3 probes active",
			rule: db.AlertRule{Metric: "loss_pct", ThresholdValue: 20, QuorumMinProbes: 2},
			stats: map[string]ingest.WindowStats{
				"Probe-Metro-A": {SampleCount: 30, LossPct: 100},
				"Probe-VPS-B":   {SampleCount: 30, LossPct: 0},
				"Probe-DC-C":    {SampleCount: 30, LossPct: 0},
			},
			wantQuorum: false,
			wantCount:  1,
		},
		{
			name: "two probes breaching triggers quorum=2",
			rule: db.AlertRule{Metric: "latency_p95", ThresholdValue: 80, QuorumMinProbes: 2},
			stats: map[string]ingest.WindowStats{
				"Probe-Metro-A": {SampleCount: 30, P95Ms: 120.5},
				"Probe-VPS-B":   {SampleCount: 30, P95Ms: 95.2},
				"Probe-DC-C":    {SampleCount: 30, P95Ms: 12.1},
			},
			wantQuorum: true,
			wantCount:  2,
		},
		{
			name: "single active probe adaptively clamps quorum=2 down to 1",
			rule: db.AlertRule{Metric: "loss_pct", ThresholdValue: 20, QuorumMinProbes: 2},
			stats: map[string]ingest.WindowStats{
				"Probe-Solo": {SampleCount: 30, LossPct: 100},
			},
			wantQuorum: true,
			wantCount:  1,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			res := EvaluateTargetQuorum(tc.rule, tc.stats)
			if res.QuorumMet != tc.wantQuorum {
				t.Fatalf("QuorumMet = %v, want %v", res.QuorumMet, tc.wantQuorum)
			}
			if len(res.BreachingProbes) != tc.wantCount {
				t.Fatalf("len(BreachingProbes) = %d, want %d", len(res.BreachingProbes), tc.wantCount)
			}
		})
	}
}

func TestNotifierTelegramHTMLAndRetry429(t *testing.T) {
	t.Parallel()

	var tgCalls atomic.Int32
	var gotTelegramPath string
	var gotTelegramPayloads []map[string]any
	var gotWebhookContent string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/bot"):
			callNum := tgCalls.Add(1)
			gotTelegramPath = r.URL.Path
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			gotTelegramPayloads = append(gotTelegramPayloads, body)
			if callNum == 3 {
				w.Header().Set("Retry-After", "1")
				w.WriteHeader(http.StatusTooManyRequests)
				_, _ = w.Write([]byte(`{"ok":false,"parameters":{"retry_after":1}}`))
				return
			}
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"ok":true,"result":{"message_id":777}}`))
		case r.URL.Path == "/webhook":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			gotWebhookContent, _ = body["content"].(string)
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	n := NewNotifierWithHTTP(srv.Client(), srv.URL)
	downMsg := AlertMessage{
		Status:         "FIRING",
		Severity:       "critical",
		RuleName:       "Global Check <prod_core>",
		TargetName:     "e1-vhp_edge",
		TargetHost:     "https://e1-vhp.com/health?a=1&b=2",
		Metric:         "loss_pct",
		Value:          100,
		Threshold:      20,
		QuorumCount:    2,
		QuorumRequired: 2,
		TotalProbes:    3,
		AffectedProbes: []string{"Probe_A", "Probe_B"},
		ProbeBreakdown: []ProbeAlertStat{
			{ProbeName: "Probe_A", LossPct: 100},
			{ProbeName: "Probe_B", LossPct: 100},
		},
		MTRBottleneck: "#4 (ae1.core.jkt / 103.10.10.1) — 60% loss, 84.5 ms",
		StartedAt:     "2026-11-17T04:30:00Z",
		Timestamp:     "2026-11-17T04:30:00Z",
	}

	if err := n.SendTelegram(context.Background(), "123:ABC", "-100999", 0, downMsg); err != nil {
		t.Fatalf("SendTelegram failed: %v", err)
	}
	if !strings.Contains(gotTelegramPath, "/bot123:ABC/sendMessage") {
		t.Fatalf("unexpected telegram path: %s", gotTelegramPath)
	}
	p0 := gotTelegramPayloads[0]
	if p0["parse_mode"] != "HTML" || p0["disable_web_page_preview"] != true {
		t.Fatalf("expected HTML parse_mode and disabled web preview, got %+v", p0)
	}
	if _, exists := p0["message_thread_id"]; exists {
		t.Fatalf("expected message_thread_id omitted when threadID=0, got %+v", p0)
	}
	text0, _ := p0["text"].(string)
	if !strings.Contains(text0, "❌ <b>[DOWN]") ||
		!strings.Contains(text0, "Alert:</b> Global Check &lt;prod_core&gt;") ||
		!strings.Contains(text0, "Condition:</b> Connection Down (100% failed)") ||
		!strings.Contains(text0, "Detected from:</b> 2 of 3 locations (Probe_A, Probe_B)") ||
		!strings.Contains(text0, "Probe Breakdown:</b>\n• Probe_A: 100% loss\n• Probe_B: 100% loss") ||
		!strings.Contains(text0, "MTR Hop:</b> #4 (ae1.core.jkt / 103.10.10.1) — 60% loss, 84.5 ms") ||
		!strings.Contains(text0, "Start:</b> 17 Nov 2026 11:30:00 WIB") {
		t.Fatalf("unexpected DOWN telegram text:\n%s", text0)
	}
	for _, forbidden := range []string{"🔴", "🟢", "🧪", "Quorum", "FIRING"} {
		if strings.Contains(text0, forbidden) {
			t.Fatalf("telegram text contains forbidden token %q:\n%s", forbidden, text0)
		}
	}

	// Verify Single-Probe adaptive formatting (concise Probe: line without "1 of 1 locations" or duplicate breakdown)
	singleFiringText := FormatTelegramHTML(AlertMessage{
		Status:         "FIRING",
		Severity:       "critical",
		RuleName:       "Single Probe Rule",
		TargetName:     "Edge-GW",
		TargetHost:     "10.10.1.1",
		Metric:         "loss_pct",
		Value:          100,
		Threshold:      20,
		QuorumCount:    1,
		QuorumRequired: 1,
		TotalProbes:    1,
		AffectedProbes: []string{"Probe-JKT"},
		ProbeBreakdown: []ProbeAlertStat{{ProbeName: "Probe-JKT", LossPct: 100}},
		StartedAt:      "2026-11-17T04:30:00Z",
		Timestamp:      "2026-11-17T04:30:00Z",
	})
	if !strings.Contains(singleFiringText, "<b>Probe:</b> Probe-JKT (100% loss)") ||
		strings.Contains(singleFiringText, "1 of 1 locations") ||
		strings.Contains(singleFiringText, "Probe Breakdown:") {
		t.Fatalf("unexpected single-probe FIRING format:\n%s", singleFiringText)
	}
	singleResolvedText := FormatTelegramHTML(AlertMessage{
		Status:         "RESOLVED",
		Severity:       "ok",
		RuleName:       "Single Probe Rule",
		TargetName:     "Edge-GW",
		TargetHost:     "10.10.1.1",
		Metric:         "loss_pct",
		PeakValue:      100,
		TotalProbes:    1,
		AffectedProbes: []string{"Probe-JKT"},
		StartedAt:      "2026-11-17T04:30:00Z",
		ResolvedAt:     "2026-11-17T04:31:00Z",
		DurationSec:    60,
		Timestamp:      "2026-11-17T04:31:00Z",
	})
	if !strings.Contains(singleResolvedText, "<b>Probe:</b> Probe-JKT") ||
		strings.Contains(singleResolvedText, "<b>Locations:</b>") {
		t.Fatalf("unexpected single-probe RESOLVED format:\n%s", singleResolvedText)
	}

	// Verify WARN, RESOLVED (SLA End + Duration), and TEST formats + 429 retry
	warnMsg := AlertMessage{
		Status:         "FIRING",
		Severity:       "warn",
		RuleName:       "Response Speed",
		TargetName:     "e1-vhp.com",
		TargetHost:     "https://e1-vhp.com",
		Metric:         "latency_p95",
		Value:          215,
		Threshold:      150,
		QuorumCount:    2,
		QuorumRequired: 2,
		TotalProbes:    3,
		AffectedProbes: []string{"Probe-JKT", "Probe-SGP"},
		StartedAt:      "2026-11-17T04:30:00Z",
		Timestamp:      "2026-11-17T04:30:00Z",
	}
	if err := n.SendTelegram(context.Background(), "123:ABC", "-100999", 4281, warnMsg); err != nil {
		t.Fatalf("SendTelegram warn with threadID failed: %v", err)
	}
	p1 := gotTelegramPayloads[1]
	if got, ok := p1["message_thread_id"].(float64); !ok || int64(got) != 4281 {
		t.Fatalf("expected message_thread_id=4281, got %+v", p1)
	}
	text1, _ := p1["text"].(string)
	if !strings.Contains(text1, "⚠️ <b>[WARN]") || !strings.Contains(text1, "Slow Connection (215 ms, normal &lt; 150 ms)") {
		t.Fatalf("unexpected WARN telegram text:\n%s", text1)
	}

	// Call #3 triggers 429 and transparently retries as Call #4
	okMsg := AlertMessage{
		Status:         "RESOLVED",
		Severity:       "ok",
		RuleName:       "Global Connection Check",
		TargetName:     "e1-vhp.com",
		TargetHost:     "https://e1-vhp.com",
		Metric:         "loss_pct",
		PeakValue:      100,
		AffectedProbes: []string{"Probe-JKT", "Probe-SGP"},
		StartedAt:      "2026-11-17T04:30:00Z",
		ResolvedAt:     "2026-11-17T04:34:25Z",
		DurationSec:    265,
		Timestamp:      "2026-11-17T04:34:25Z",
	}
	if err := n.SendTelegram(context.Background(), "123:ABC", "-100999", 4281, okMsg); err != nil {
		t.Fatalf("SendTelegram resolved with 429 retry failed: %v", err)
	}
	textOk, _ := gotTelegramPayloads[len(gotTelegramPayloads)-1]["text"].(string)
	if !strings.Contains(textOk, "✅ <b>[OK] e1-vhp.com (https://e1-vhp.com) — Connection Restored</b>") ||
		!strings.Contains(textOk, "Start:</b> 17 Nov 2026 11:30:00 WIB") ||
		!strings.Contains(textOk, "End:</b> 17 Nov 2026 11:34:25 WIB") ||
		!strings.Contains(textOk, "Duration:</b> 4m 25s (265s) | Peak: 100% failed") ||
		!strings.Contains(textOk, "Locations:</b> Probe-JKT, Probe-SGP") {
		t.Fatalf("unexpected RESOLVED telegram text:\n%s", textOk)
	}

	testText := FormatTelegramHTML(AlertMessage{
		Status:    "TEST",
		Severity:  "test",
		Summary:   "Notification connection verified",
		Timestamp: "2026-11-17T04:35:00Z",
	})
	if !strings.Contains(testText, "⚠️ <b>[TEST] Notification Check</b>") || strings.Contains(testText, "🧪") {
		t.Fatalf("unexpected TEST telegram text:\n%s", testText)
	}

	if err := n.SendWebhook(context.Background(), srv.URL+"/webhook", downMsg); err != nil {
		t.Fatalf("SendWebhook failed: %v", err)
	}
	if !strings.Contains(gotWebhookContent, "[DOWN]") {
		t.Fatalf("unexpected webhook content: %s", gotWebhookContent)
	}
}

type fakeAlertStore struct {
	mu           sync.Mutex
	rules        []db.AlertRule
	probes       []db.Probe
	targets      []db.Target
	channels     []db.AlertChannel
	incidents    []db.Incident
	mtrSnapshots map[uuid.UUID][]db.MTRSnapshot
}

func (f *fakeAlertStore) ListAlertRules(context.Context) ([]db.AlertRule, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]db.AlertRule(nil), f.rules...), nil
}
func (f *fakeAlertStore) ListProbes(context.Context) ([]db.Probe, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]db.Probe(nil), f.probes...), nil
}
func (f *fakeAlertStore) ListTargets(context.Context) ([]db.Target, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]db.Target(nil), f.targets...), nil
}
func (f *fakeAlertStore) ListAlertChannels(context.Context) ([]db.AlertChannel, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]db.AlertChannel(nil), f.channels...), nil
}
func (f *fakeAlertStore) ListOpenIncidents(context.Context) ([]db.Incident, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var open []db.Incident
	for _, inc := range f.incidents {
		if inc.Status == "open" {
			open = append(open, inc)
		}
	}
	return open, nil
}
func (f *fakeAlertStore) UpsertOpenIncident(_ context.Context, ruleID uuid.UUID, targetID *uuid.UUID, affectedProbes []string, peak float64, severity string, now time.Time, summary string) (db.Incident, bool, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i, inc := range f.incidents {
		if inc.Status == "open" && inc.RuleID == ruleID && ((inc.TargetID == nil && targetID == nil) || (inc.TargetID != nil && targetID != nil && *inc.TargetID == *targetID)) {
			escalated := inc.Severity == "warn" && severity == "critical"
			if severity == "critical" {
				inc.Severity = "critical"
			}
			if peak > inc.PeakValue {
				inc.PeakValue = peak
			}
			inc.AffectedProbes = affectedProbes
			inc.Summary = summary
			f.incidents[i] = inc
			return inc, false, escalated, nil
		}
	}
	inc := db.Incident{
		ID:                 uuid.New(),
		RuleID:             ruleID,
		TargetID:           targetID,
		Status:             "open",
		Severity:           severity,
		AffectedProbes:     affectedProbes,
		PeakValue:          peak,
		StartedAt:          now,
		TelegramMessageIDs: make(map[string]int64),
		Summary:            summary,
	}
	f.incidents = append(f.incidents, inc)
	return inc, true, false, nil
}
func (f *fakeAlertStore) ResolveOpenIncident(_ context.Context, ruleID uuid.UUID, targetID *uuid.UUID, now time.Time) (*db.Incident, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i, inc := range f.incidents {
		if inc.Status == "open" && inc.RuleID == ruleID && ((inc.TargetID == nil && targetID == nil) || (inc.TargetID != nil && targetID != nil && *inc.TargetID == *targetID)) {
			inc.Status = "resolved"
			t := now
			inc.ResolvedAt = &t
			f.incidents[i] = inc
			cp := inc
			return &cp, nil
		}
	}
	return nil, nil
}
func (f *fakeAlertStore) MarkIncidentNotified(_ context.Context, id uuid.UUID, notifiedSeverity string, now time.Time, telegramMsgIDs map[string]int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i, inc := range f.incidents {
		if inc.ID == id {
			if inc.TelegramMessageIDs == nil {
				inc.TelegramMessageIDs = make(map[string]int64)
			}
			for k, v := range telegramMsgIDs {
				inc.TelegramMessageIDs[k] = v
			}
			if !now.IsZero() {
				t := now
				inc.LastNotifiedAt = &t
				if inc.NotifiedSeverity == "critical" || notifiedSeverity == "critical" {
					inc.NotifiedSeverity = "critical"
				} else if notifiedSeverity != "" {
					inc.NotifiedSeverity = notifiedSeverity
				}
			}
			f.incidents[i] = inc
			break
		}
	}
	return nil
}
func (f *fakeAlertStore) ListMTRSnapshots(_ context.Context, targetID uuid.UUID, limit int) ([]db.MTRSnapshot, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.mtrSnapshots == nil {
		return nil, nil
	}
	snaps := f.mtrSnapshots[targetID]
	if limit > 0 && len(snaps) > limit {
		snaps = snaps[:limit]
	}
	return append([]db.MTRSnapshot(nil), snaps...), nil
}

func TestEvaluatorEscalationOfflineGuardAndChannelRouting(t *testing.T) {
	t.Parallel()

	var mu sync.Mutex
	sentByThread := make(map[int64][]string)
	payByThread := make(map[int64][]map[string]any)
	var msgIDSeq atomic.Int64
	msgIDSeq.Store(5000)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		tid := int64(0)
		if v, ok := body["message_thread_id"].(float64); ok {
			tid = int64(v)
		}
		txt, _ := body["text"].(string)
		mu.Lock()
		sentByThread[tid] = append(sentByThread[tid], txt)
		payByThread[tid] = append(payByThread[tid], body)
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
		nextID := msgIDSeq.Add(1)
		_, _ = w.Write([]byte(`{"ok":true,"result":{"message_id":` + jsonNumber(nextID) + `}}`))
	}))
	defer srv.Close()

	aesKey := auth.DeriveAESKey("test-aes-secret-at-least-32-chars!!")
	encCh1, _ := auth.EncryptAESGCM(aesKey, []byte(`{"bot_token":"123:ABC","chat_id":"-1001","thread_id":101}`))
	encCh2, _ := auth.EncryptAESGCM(aesKey, []byte(`{"bot_token":"123:ABC","chat_id":"-1001","thread_id":202}`))
	ch1ID := uuid.New()
	ch2ID := uuid.New()

	p1ID := uuid.New()
	t1ID := uuid.New()
	t0 := time.Date(2026, 11, 17, 4, 0, 0, 0, time.UTC)
	now := t0

	store := &fakeAlertStore{
		probes: []db.Probe{
			{ID: p1ID, Name: "Probe-JKT", Status: "online"},
		},
		targets: []db.Target{
			{ID: t1ID, Name: "e1-vhp.com", Host: "https://e1-vhp.com", IntervalSec: 1, Enabled: true, AssignAllProbes: true},
		},
		channels: []db.AlertChannel{
			{ID: ch1ID, Type: "telegram", Name: "Ops Thread", ConfigEncrypted: encCh1, Enabled: true},
			{ID: ch2ID, Type: "telegram", Name: "Other Thread", ConfigEncrypted: encCh2, Enabled: true},
		},
		rules: []db.AlertRule{
			{
				ID:              uuid.New(),
				Name:            "Global Loss Check",
				Metric:          "loss_pct",
				ThresholdValue:  20,
				DurationSec:     30,
				QuorumMinProbes: 2, // Higher than 1 assigned probe -> capped cleanly for global rule
				CooldownSec:     0, // State-change + escalation only (no repeat spam)
				ConfirmSec:      1, // Quick confirm for escalation/channel test (Auto holddown tested separately)
				RecoverSec:      0,
				ChannelIDs:      []uuid.UUID{ch1ID},
				Enabled:         true,
			},
		},
	}

	cache := ingest.NewRollingCache(10 * time.Minute)
	rtt := int32(25000)
	// Add 4 samples with 25% loss (1/4 = 25% -> WARN)
	for i := 0; i < 4; i++ {
		cache.Add(p1ID, t1ID, now.Add(time.Duration(i-5)*time.Second), &rtt, 1000, i == 0, now)
	}

	ev := NewEvaluator(store, cache, nil, NewNotifierWithHTTP(srv.Client(), srv.URL), aesKey, func() time.Time { return now })
	ev.SetSyncDispatch(true)

	// Cycle 1: enters pending at t0, confirms at t0+2s -> sends [WARN] only to ch1 (thread 101)
	if err := ev.EvaluateOnce(context.Background()); err != nil {
		t.Fatalf("EvaluateOnce pending start: %v", err)
	}
	if len(sentByThread[101]) != 0 {
		t.Fatalf("expected 0 messages while pending confirm, got %d", len(sentByThread[101]))
	}
	now = now.Add(2 * time.Second)
	for i := 0; i < 4; i++ {
		cache.Add(p1ID, t1ID, now.Add(time.Duration(i-5)*time.Second), &rtt, 1000, i == 0, now)
	}
	if err := ev.EvaluateOnce(context.Background()); err != nil {
		t.Fatalf("EvaluateOnce cycle 1 confirm: %v", err)
	}
	if len(sentByThread[101]) != 1 || len(sentByThread[202]) != 0 {
		t.Fatalf("expected 1 message in thread 101 and 0 in 202, got 101=%d 202=%d", len(sentByThread[101]), len(sentByThread[202]))
	}
	if !strings.Contains(sentByThread[101][0], "⚠️ <b>[WARN]") {
		t.Fatalf("expected [WARN] message, got:\n%s", sentByThread[101][0])
	}
	if _, hasReply := payByThread[101][0]["reply_to_message_id"]; hasReply {
		t.Fatalf("initial FIRING message must not have reply_to_message_id, got %+v", payByThread[101][0])
	}

	// Cycle 2 at +10s with same severity and CooldownSec=0 -> NO duplicate notification
	now = t0.Add(10 * time.Second)
	for i := 0; i < 4; i++ {
		cache.Add(p1ID, t1ID, now.Add(-time.Duration(i+1)*time.Second), &rtt, 1000, i == 0, now)
	}
	if err := ev.EvaluateOnce(context.Background()); err != nil {
		t.Fatalf("EvaluateOnce cycle 2: %v", err)
	}
	if len(sentByThread[101]) != 1 {
		t.Fatalf("expected no duplicate notification when cooldown=0, got %d", len(sentByThread[101]))
	}

	// Cycle 3: escalate to 100% loss -> enters critical escalation confirm at +43s, confirms at +45s with Elapsed: 45s and replies to message 5001
	now = t0.Add(43 * time.Second)
	for i := 0; i < 35; i++ {
		cache.Add(p1ID, t1ID, now.Add(-time.Duration(i)*time.Second), nil, 0, true, now)
	}
	if err := ev.EvaluateOnce(context.Background()); err != nil {
		t.Fatalf("EvaluateOnce cycle 3 pending escalation: %v", err)
	}
	if len(sentByThread[101]) != 1 {
		t.Fatalf("expected escalation held down before confirm duration, got %d", len(sentByThread[101]))
	}

	now = t0.Add(45 * time.Second)
	for i := 0; i < 35; i++ {
		cache.Add(p1ID, t1ID, now.Add(-time.Duration(i)*time.Second), nil, 0, true, now)
	}
	if err := ev.EvaluateOnce(context.Background()); err != nil {
		t.Fatalf("EvaluateOnce cycle 3 confirm escalation: %v", err)
	}
	if len(sentByThread[101]) != 2 || !strings.Contains(sentByThread[101][1], "❌ <b>[DOWN]") || !strings.Contains(sentByThread[101][1], "Elapsed:</b> 45s") {
		t.Fatalf("expected escalation [DOWN] with Elapsed, got %+v", sentByThread[101])
	}
	if gotReply, _ := payByThread[101][1]["reply_to_message_id"].(float64); int64(gotReply) != 5001 {
		t.Fatalf("expected ESCALATED to reply_to_message_id=5001, got %+v", payByThread[101][1])
	}

	// Cycle 4 at +60s: Probe goes offline -> MUST NOT falsely resolve incident
	now = t0.Add(60 * time.Second)
	store.probes[0].Status = "offline"
	if err := ev.EvaluateOnce(context.Background()); err != nil {
		t.Fatalf("EvaluateOnce cycle 4: %v", err)
	}
	if len(sentByThread[101]) != 2 || store.incidents[0].Status != "open" {
		t.Fatalf("expected open incident preserved while probe offline, sent=%d status=%s", len(sentByThread[101]), store.incidents[0].Status)
	}

	// Cycle 5 at +125s: Probe back online with healthy samples -> sends [OK] with Start, End, Duration (2m 05s (125s)) threaded to 5001
	now = t0.Add(125 * time.Second)
	store.probes[0].Status = "online"
	for i := 0; i < 35; i++ {
		cache.Add(p1ID, t1ID, now.Add(-time.Duration(i)*time.Second), &rtt, 500, false, now)
	}
	if err := ev.EvaluateOnce(context.Background()); err != nil {
		t.Fatalf("EvaluateOnce cycle 5: %v", err)
	}
	if len(sentByThread[101]) != 3 {
		t.Fatalf("expected 3rd notification [OK], got %d", len(sentByThread[101]))
	}
	okMsg := sentByThread[101][2]
	if !strings.Contains(okMsg, "✅ <b>[OK]") || !strings.Contains(okMsg, "Duration:</b> 2m 05s (125s)") || store.incidents[0].Status != "resolved" {
		t.Fatalf("expected [OK] with exact SLA duration, got:\n%s", okMsg)
	}
	if gotReply, _ := payByThread[101][2]["reply_to_message_id"].(float64); int64(gotReply) != 5001 {
		t.Fatalf("expected RESOLVED to reply_to_message_id=5001, got %+v", payByThread[101][2])
	}
}

func jsonNumber(n int64) string {
	b, _ := json.Marshal(n)
	return string(b)
}

func TestEvaluatorAntiFalseAlarmHoldDownAndSLATimestamps(t *testing.T) {
	t.Parallel()

	var mu sync.Mutex
	var sent []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		txt, _ := body["text"].(string)
		mu.Lock()
		sent = append(sent, txt)
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true,"result":{"message_id":101}}`))
	}))
	defer srv.Close()

	aesKey := auth.DeriveAESKey("test-aes-secret-at-least-32-chars!!")
	encCh, _ := auth.EncryptAESGCM(aesKey, []byte(`{"bot_token":"123:ABC","chat_id":"-1001"}`))

	p1ID := uuid.New()
	tWarnID := uuid.New()
	tDownID := uuid.New()
	t0 := time.Date(2026, 11, 17, 4, 0, 0, 0, time.UTC) // 11:00:00 WIB
	now := t0

	store := &fakeAlertStore{
		probes: []db.Probe{{ID: p1ID, Name: "Probe-JKT", Status: "online"}},
		targets: []db.Target{
			{ID: tWarnID, Name: "Intermittent-Link", Host: "1.1.1.1", IntervalSec: 1, Enabled: true, AssignAllProbes: true},
			{ID: tDownID, Name: "HardDown-Link", Host: "8.8.8.8", IntervalSec: 1, Enabled: true, AssignAllProbes: true},
		},
		channels: []db.AlertChannel{
			{ID: uuid.New(), Type: "telegram", Name: "Ops", ConfigEncrypted: encCh, Enabled: true},
		},
		rules: []db.AlertRule{
			{
				ID:              uuid.New(),
				Name:            "Auto HoldDown Rule",
				Metric:          "loss_pct",
				ThresholdValue:  20,
				DurationSec:     30,
				QuorumMinProbes: 1,
				CooldownSec:     0,
				ConfirmSec:      0,  // Auto Smart: 25s DOWN / 60s WARN
				RecoverSec:      45, // 45s clean streak required
				Enabled:         true,
			},
		},
	}

	cache := ingest.NewRollingCache(10 * time.Minute)
	rtt := int32(20000)
	ev := NewEvaluator(store, cache, nil, NewNotifierWithHTTP(srv.Client(), srv.URL), aesKey, func() time.Time { return now })
	ev.SetSyncDispatch(true)

	// 1. Short intermittent blip (< 60s) on tWarn + brief 20s drop (< 25s) on tDown -> ZERO false alarms!
	for i := 0; i < 4; i++ {
		cache.Add(p1ID, tWarnID, now.Add(time.Duration(i-5)*time.Second), &rtt, 500, i == 0, now) // 25% loss (WARN -> 60s confirm)
		cache.Add(p1ID, tDownID, now.Add(time.Duration(i-5)*time.Second), nil, 0, true, now)       // 100% loss (DOWN -> 25s confirm)
	}
	if err := ev.EvaluateOnce(context.Background()); err != nil {
		t.Fatalf("blip start eval: %v", err)
	}
	now = t0.Add(20 * time.Second)
	for i := 0; i < 20; i++ {
		cache.Add(p1ID, tWarnID, now.Add(-time.Duration(i)*time.Second), &rtt, 500, i%4 == 0, now)
		cache.Add(p1ID, tDownID, now.Add(-time.Duration(i)*time.Second), nil, 0, true, now)
	}
	if err := ev.EvaluateOnce(context.Background()); err != nil {
		t.Fatalf("t+20s eval: %v", err)
	}
	if len(sent) != 0 || len(store.incidents) != 0 {
		t.Fatalf("expected 0 false alerts before confirm threshold, sent=%d incidents=%d", len(sent), len(store.incidents))
	}

	// First keep tDown down at t+25s -> confirms [DOWN] with StartedAt = t0!
	now = t0.Add(25 * time.Second)
	for i := 0; i < 25; i++ {
		cache.Add(p1ID, tDownID, now.Add(-time.Duration(i)*time.Second), nil, 0, true, now)
	}
	// Make tWarn healthy at t+25s so its <60s blip cancels quietly without creating an incident
	for i := 0; i < 35; i++ {
		cache.Add(p1ID, tWarnID, now.Add(-time.Duration(i)*time.Second), &rtt, 500, false, now)
	}
	if err := ev.EvaluateOnce(context.Background()); err != nil {
		t.Fatalf("t+25s eval: %v", err)
	}
	if len(sent) != 1 || len(store.incidents) != 1 {
		t.Fatalf("expected only HardDown-Link confirmed at +25s (Intermittent blip cancelled), sent=%d incidents=%d", len(sent), len(store.incidents))
	}
	if !strings.Contains(sent[0], "❌ <b>[DOWN] HardDown-Link") || !strings.Contains(sent[0], "Start:</b> 17 Nov 2026 11:00:00 WIB") {
		t.Fatalf("expected Start timestamp to match initial detection t0 (11:00:00 WIB), got:\n%s", sent[0])
	}

	// 2. Test flapping recovery on HardDown-Link: recovers briefly at t+60s, drops again at t+90s (<45s recovery wait) -> NO false [OK] spam!
	now = t0.Add(60 * time.Second)
	for i := 0; i < 35; i++ {
		cache.Add(p1ID, tDownID, now.Add(-time.Duration(i)*time.Second), &rtt, 500, false, now)
	}
	if err := ev.EvaluateOnce(context.Background()); err != nil {
		t.Fatalf("t+60s recover start: %v", err)
	}
	if len(sent) != 1 || store.incidents[0].Status != "open" {
		t.Fatalf("expected [OK] held back during 45s recovery buffer, sent=%d status=%s", len(sent), store.incidents[0].Status)
	}

	// Link flaps back to down at t+90s (only 30s healthy < 45s) -> still 1 single incident, still no extra notif
	now = t0.Add(90 * time.Second)
	for i := 0; i < 35; i++ {
		cache.Add(p1ID, tDownID, now.Add(-time.Duration(i)*time.Second), nil, 0, true, now)
	}
	if err := ev.EvaluateOnce(context.Background()); err != nil {
		t.Fatalf("t+90s flap: %v", err)
	}
	if len(sent) != 1 || store.incidents[0].Status != "open" {
		t.Fatalf("expected flap during recovery buffer to keep single incident open, sent=%d status=%s", len(sent), store.incidents[0].Status)
	}

	// 3. Real recovery starts cleanly at t+120s (11:02:00 WIB), confirmed after 45s at t+165s -> SLA Duration must be 2m 00s (120s), End = 11:02:00 WIB!
	now = t0.Add(120 * time.Second)
	for i := 0; i < 35; i++ {
		cache.Add(p1ID, tDownID, now.Add(-time.Duration(i)*time.Second), &rtt, 500, false, now)
	}
	if err := ev.EvaluateOnce(context.Background()); err != nil {
		t.Fatalf("t+120s real recover start: %v", err)
	}
	if len(sent) != 1 || store.incidents[0].Status != "open" {
		t.Fatalf("expected recovery buffer still waiting at t+120s, sent=%d", len(sent))
	}

	now = t0.Add(165 * time.Second)
	for i := 0; i < 35; i++ {
		cache.Add(p1ID, tDownID, now.Add(-time.Duration(i)*time.Second), &rtt, 500, false, now)
	}
	if err := ev.EvaluateOnce(context.Background()); err != nil {
		t.Fatalf("t+165s recover confirm: %v", err)
	}
	if len(sent) != 2 || store.incidents[0].Status != "resolved" {
		t.Fatalf("expected [OK] sent after 45s clean streak, sent=%d status=%s", len(sent), store.incidents[0].Status)
	}
	if !strings.Contains(sent[1], "✅ <b>[OK] HardDown-Link (8.8.8.8) — Connection Restored</b>") ||
		!strings.Contains(sent[1], "Start:</b> 17 Nov 2026 11:00:00 WIB") ||
		!strings.Contains(sent[1], "End:</b> 17 Nov 2026 11:02:00 WIB") ||
		!strings.Contains(sent[1], "Duration:</b> 2m 00s (120s)") {
		t.Fatalf("expected exact SLA Start/End/Duration in [OK] message, got:\n%s", sent[1])
	}
}

func TestEvaluatorReliabilitySeverityFilterAckMuteAndMTR(t *testing.T) {
	t.Parallel()

	var failTelegram atomic.Bool
	var mu sync.Mutex
	sentByChat := make(map[string][]string)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if failTelegram.Load() {
			w.WriteHeader(http.StatusBadGateway)
			_, _ = w.Write([]byte(`{"ok":false,"description":"Bad Gateway"}`))
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		chatID, _ := body["chat_id"].(string)
		txt, _ := body["text"].(string)
		mu.Lock()
		sentByChat[chatID] = append(sentByChat[chatID], txt)
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true,"result":{"message_id":9001}}`))
	}))
	defer srv.Close()

	aesKey := auth.DeriveAESKey("test-aes-secret-at-least-32-chars!!")
	encAll, _ := auth.EncryptAESGCM(aesKey, []byte(`{"bot_token":"123:ABC","chat_id":"-100ALL"}`))
	encCrit, _ := auth.EncryptAESGCM(aesKey, []byte(`{"bot_token":"123:ABC","chat_id":"-100CRIT"}`))

	pOnline := uuid.New()
	pOffline := uuid.New()
	tTarget := uuid.New()
	t0 := time.Date(2026, 11, 17, 5, 0, 0, 0, time.UTC)
	now := t0

	// Start with target muted for 10s
	muteUntil := t0.Add(10 * time.Second)
	store := &fakeAlertStore{
		probes: []db.Probe{
			{ID: pOnline, Name: "Probe-JKT", Status: "online"},
			{ID: pOffline, Name: "Probe-SGP", Status: "offline"},
		},
		targets: []db.Target{
			{
				ID:              tTarget,
				Name:            "Core-BGP",
				Host:            "103.10.10.2",
				IntervalSec:     1,
				Enabled:         true,
				AssignAllProbes: false,
				ProbeIDs:        []uuid.UUID{pOnline, pOffline}, // 2 assigned, only 1 online!
				MutedUntil:      &muteUntil,
			},
		},
		channels: []db.AlertChannel{
			{ID: uuid.New(), Type: "telegram", Name: "All Channel", ConfigEncrypted: encAll, SeverityFilter: "all", Enabled: true},
			{ID: uuid.New(), Type: "telegram", Name: "Critical Channel", ConfigEncrypted: encCrit, SeverityFilter: "critical", Enabled: true},
		},
		rules: []db.AlertRule{
			{
				ID:              uuid.New(),
				Name:            "Single-Target Quorum=2 Rule",
				TargetID:        &tTarget,
				Metric:          "loss_pct",
				ThresholdValue:  20,
				DurationSec:     30,
				QuorumMinProbes: 2, // Clamped to 1 because only 1 assigned probe is online!
				CooldownSec:     60,
				ConfirmSec:      1,
				RecoverSec:      0,
				Enabled:         true,
			},
		},
		mtrSnapshots: map[uuid.UUID][]db.MTRSnapshot{
			tTarget: {
				{
					ID:         uuid.New(),
					ProbeID:    pOnline,
					ProbeName:  "Probe-JKT",
					TargetID:   tTarget,
					CapturedAt: t0.Add(5 * time.Second),
					Hops: []protocol.MTRHop{
						{Hop: 1, IP: "10.0.0.1", LossPct: 0, AvgUs: 1200},
						{Hop: 2, IP: "103.10.10.1", Host: "ae0.jkt.edge", LossPct: 40, AvgUs: 45200},
					},
				},
			},
		},
	}

	cache := ingest.NewRollingCache(10 * time.Minute)
	rtt := int32(20000)
	ev := NewEvaluator(store, cache, nil, NewNotifierWithHTTP(srv.Client(), srv.URL), aesKey, func() time.Time { return now })
	ev.SetSyncDispatch(true)

	// 1. While target is muted (t0..t0+5s), no incidents or notifications are emitted
	for i := 0; i < 4; i++ {
		cache.Add(pOnline, tTarget, now.Add(time.Duration(i-5)*time.Second), &rtt, 500, i == 0, now) // 25% loss (WARN)
	}
	_ = ev.EvaluateOnce(context.Background())
	now = t0.Add(5 * time.Second)
	for i := 0; i < 4; i++ {
		cache.Add(pOnline, tTarget, now.Add(time.Duration(i-5)*time.Second), &rtt, 500, i == 0, now)
	}
	_ = ev.EvaluateOnce(context.Background())
	if len(sentByChat["-100ALL"]) != 0 || len(store.incidents) != 0 {
		t.Fatalf("expected 0 alerts while target is muted, got sent=%d incidents=%d", len(sentByChat["-100ALL"]), len(store.incidents))
	}

	// 2. Mute expires at t0+12s; simulate transient Telegram failure on first confirm at t0+14s
	now = t0.Add(12 * time.Second)
	for i := 0; i < 4; i++ {
		cache.Add(pOnline, tTarget, now.Add(time.Duration(i-5)*time.Second), &rtt, 500, i == 0, now) // 25% loss (WARN)
	}
	_ = ev.EvaluateOnce(context.Background()) // starts pendingSince

	failTelegram.Store(true)
	now = t0.Add(14 * time.Second)
	for i := 0; i < 4; i++ {
		cache.Add(pOnline, tTarget, now.Add(time.Duration(i-5)*time.Second), &rtt, 500, i == 0, now) // 25% loss (WARN)
	}
	_ = ev.EvaluateOnce(context.Background()) // confirm reached, Telegram fails -> LastNotifiedAt must stay nil!
	if len(store.incidents) != 1 || store.incidents[0].LastNotifiedAt != nil {
		t.Fatalf("expected open incident with LastNotifiedAt=nil after failed dispatch, got %+v", store.incidents)
	}

	// 3. Next cycle at t0+19s: Telegram recovers -> retries initial WARN alert!
	// Critical-only channel (-100CRIT) must NOT receive WARN, while All channel (-100ALL) receives WARN with MTR Hop!
	failTelegram.Store(false)
	now = t0.Add(19 * time.Second)
	for i := 0; i < 4; i++ {
		cache.Add(pOnline, tTarget, now.Add(time.Duration(i-5)*time.Second), &rtt, 500, i == 0, now)
	}
	_ = ev.EvaluateOnce(context.Background())
	if len(sentByChat["-100ALL"]) != 1 || len(sentByChat["-100CRIT"]) != 0 {
		t.Fatalf("expected 1 message on -100ALL and 0 on -100CRIT for WARN, got ALL=%d CRIT=%d", len(sentByChat["-100ALL"]), len(sentByChat["-100CRIT"]))
	}
	if !strings.Contains(sentByChat["-100ALL"][0], "MTR Hop:</b> #2 (ae0.jkt.edge / 103.10.10.1) — 40% loss, 45.2 ms") {
		t.Fatalf("expected MTR Hop in Telegram alert, got:\n%s", sentByChat["-100ALL"][0])
	}

	// 4. Operator acknowledges the open incident -> suppresses cooldown repeat reminder at t0+90s (>60s cooldown)
	ackTime := t0.Add(30 * time.Second)
	store.incidents[0].AcknowledgedAt = &ackTime
	store.incidents[0].AcknowledgedBy = "admin"

	now = t0.Add(90 * time.Second)
	for i := 0; i < 4; i++ {
		cache.Add(pOnline, tTarget, now.Add(time.Duration(i-5)*time.Second), &rtt, 500, i == 0, now)
	}
	_ = ev.EvaluateOnce(context.Background())
	if len(sentByChat["-100ALL"]) != 1 {
		t.Fatalf("expected repeat reminder suppressed after acknowledge, got %d messages", len(sentByChat["-100ALL"]))
	}

	// 5. Incident resolves at t0+120s -> [OK] is delivered to -100ALL (despite ack), and NOT sent to -100CRIT (no orphan [OK] for warn-only incident!)
	now = t0.Add(120 * time.Second)
	for i := 0; i < 35; i++ {
		cache.Add(pOnline, tTarget, now.Add(-time.Duration(i)*time.Second), &rtt, 500, false, now)
	}
	_ = ev.EvaluateOnce(context.Background())
	if len(sentByChat["-100ALL"]) != 2 || !strings.Contains(sentByChat["-100ALL"][1], "✅ <b>[OK]") {
		t.Fatalf("expected [OK] sent to -100ALL on resolve, got %+v", sentByChat["-100ALL"])
	}
	if len(sentByChat["-100CRIT"]) != 0 {
		t.Fatalf("expected 0 orphan [OK] on -100CRIT for WARN-only incident, got %d", len(sentByChat["-100CRIT"]))
	}
}

func TestPerChatPacingAndCurrentVsPeakTelemetry(t *testing.T) {
	t.Parallel()

	var inFlight atomic.Int32
	var maxConcurrent atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cur := inFlight.Add(1)
		for {
			prev := maxConcurrent.Load()
			if cur <= prev || maxConcurrent.CompareAndSwap(prev, cur) {
				break
			}
		}
		time.Sleep(15 * time.Millisecond)
		inFlight.Add(-1)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true,"result":{"message_id":321}}`))
	}))
	defer srv.Close()

	n := NewNotifierWithHTTP(srv.Client(), srv.URL)
	n.SetMinChatInterval(10 * time.Millisecond)

	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = n.SendTelegram(context.Background(), "123:ABC", "-100SAME", 0, AlertMessage{
				Status:     "FIRING",
				Severity:   "critical",
				TargetName: "Burst-Node",
				Metric:     "loss_pct",
				Value:      100,
				Threshold:  20,
				Timestamp:  "2026-11-17T05:00:00Z",
			})
		}()
	}
	wg.Wait()
	if maxConcurrent.Load() > 1 {
		t.Fatalf("expected per-chat requests to be serialized (maxConcurrent=1), got %d", maxConcurrent.Load())
	}

	// Verify Current vs. Peak telemetry formatting on ongoing reminder when PeakValue > Value
	reminderText := FormatTelegramHTML(AlertMessage{
		Status:         "FIRING",
		Severity:       "critical",
		RuleName:       "High Latency Rule",
		TargetName:     "API-Edge",
		TargetHost:     "api.example.com",
		Metric:         "latency_p95",
		Value:          180,
		PeakValue:      420,
		Threshold:      150,
		QuorumCount:    1,
		QuorumRequired: 1,
		TotalProbes:    1,
		AffectedProbes: []string{"Probe-JKT"},
		StartedAt:      "2026-11-17T05:00:00Z",
		DurationSec:    300,
		Timestamp:      "2026-11-17T05:05:00Z",
	})
	if !strings.Contains(reminderText, "Slow Connection (180 ms, normal &lt; 150 ms)") ||
		!strings.Contains(reminderText, "Elapsed:</b> 5m 00s (300s) | Peak: 420 ms") {
		t.Fatalf("expected both current value (180 ms) and incident peak (420 ms) in reminder, got:\n%s", reminderText)
	}
}

func TestSummarizeMTRBottleneckAndRetryAfterUnCapped(t *testing.T) {
	t.Parallel()

	t0 := time.Date(2026, 11, 17, 6, 0, 0, 0, time.UTC)

	// 1. Intermediate silent (*) hop must not hijack bottleneck when downstream destination responds with high latency
	snapsSilentMid := []db.MTRSnapshot{
		{
			CapturedAt: t0,
			Hops: []protocol.MTRHop{
				{Hop: 1, IP: "10.0.0.1", LossPct: 0, AvgUs: 1000},
				{Hop: 2, IP: "*", LossPct: 100, AvgUs: 0},
				{Hop: 3, IP: "8.8.8.8", Host: "dns.google", LossPct: 0, AvgUs: 250000},
			},
		},
	}
	gotMid := SummarizeMTRBottleneck(snapsSilentMid, t0)
	if gotMid != "#3 (dns.google / 8.8.8.8) — 0% loss, 250.0 ms" {
		t.Fatalf("expected responding high-latency hop #3 instead of silent *, got %q", gotMid)
	}

	// 2. Non-responding final hop (*) with 100% loss IS reported when target itself is unreachable
	snapsDeadEnd := []db.MTRSnapshot{
		{
			CapturedAt: t0,
			Hops: []protocol.MTRHop{
				{Hop: 1, IP: "10.0.0.1", LossPct: 0, AvgUs: 1000},
				{Hop: 2, IP: "*", LossPct: 100, AvgUs: 0},
			},
		},
	}
	gotDead := SummarizeMTRBottleneck(snapsDeadEnd, t0)
	if gotDead != "#2 (*) — 100% loss" {
		t.Fatalf("expected dead-end hop #2 (*), got %q", gotDead)
	}

	// 3. Stale snapshot (> 2m before incidentStart) is ignored
	staleSnaps := []db.MTRSnapshot{
		{
			CapturedAt: t0.Add(-5 * time.Minute),
			Hops:       []protocol.MTRHop{{Hop: 1, IP: "1.1.1.1", LossPct: 10, AvgUs: 5000}},
		},
	}
	if gotStale := SummarizeMTRBottleneck(staleSnaps, t0); gotStale != "" {
		t.Fatalf("expected empty summary for stale snapshot, got %q", gotStale)
	}

	// 4. SendTelegramWithReply honors full retry_after > 5s (e.g. 12s) and returns error if retries exhausted
	var mu sync.Mutex
	var recordedWaits []time.Duration
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)
		if n <= 2 {
			w.Header().Set("Retry-After", "12")
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`{"ok":false,"parameters":{"retry_after":12}}`))
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true,"result":{"message_id":444}}`))
	}))
	defer srv.Close()

	n := NewNotifierWithHTTP(srv.Client(), srv.URL)
	n.minChatInterval = 0
	n.afterFn = func(d time.Duration) <-chan time.Time {
		mu.Lock()
		recordedWaits = append(recordedWaits, d)
		mu.Unlock()
		ch := make(chan time.Time, 1)
		ch <- time.Now()
		return ch
	}

	msgID, err := n.SendTelegramWithReply(context.Background(), "123:ABC", "-1001", 0, 0, AlertMessage{
		Status:     "FIRING",
		Severity:   "critical",
		TargetName: "Node-A",
		Metric:     "loss_pct",
		Value:      100,
		Threshold:  20,
		Timestamp:  "2026-11-17T06:00:00Z",
	})
	if err != nil || msgID != 444 {
		t.Fatalf("expected retry success with msgID=444, got msgID=%d err=%v", msgID, err)
	}
	mu.Lock()
	waitsCopy := append([]time.Duration(nil), recordedWaits...)
	mu.Unlock()
	if len(waitsCopy) != 2 || waitsCopy[0] != 12*time.Second || waitsCopy[1] != 12*time.Second {
		t.Fatalf("expected full 12s retry_after waits (uncapped), got %v", waitsCopy)
	}

	// Exhaust all 3 attempts with 429 -> must return non-nil error
	srvAlways429 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "7")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"ok":false,"parameters":{"retry_after":7}}`))
	}))
	defer srvAlways429.Close()
	nFail := NewNotifierWithHTTP(srvAlways429.Client(), srvAlways429.URL)
	nFail.minChatInterval = 0
	nFail.afterFn = n.afterFn
	if _, err := nFail.SendTelegramWithReply(context.Background(), "123:ABC", "-1001", 0, 0, AlertMessage{
		Status:     "FIRING",
		Severity:   "critical",
		TargetName: "Node-A",
		Metric:     "loss_pct",
		Value:      100,
		Threshold:  20,
		Timestamp:  "2026-11-17T06:00:00Z",
	}); err == nil {
		t.Fatalf("expected non-nil error when 429 retries are exhausted")
	}
}

func TestEvaluatorPartialMultiChannelRetryAndPreMuteRecovery(t *testing.T) {
	t.Parallel()

	var failTelegram atomic.Bool
	var mu sync.Mutex
	var tgMsgs []string
	var whPayloads []map[string]any

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/bot"):
			if failTelegram.Load() {
				w.WriteHeader(http.StatusBadGateway)
				_, _ = w.Write([]byte(`{"ok":false,"description":"upstream error"}`))
				return
			}
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			txt, _ := body["text"].(string)
			mu.Lock()
			tgMsgs = append(tgMsgs, txt)
			mu.Unlock()
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"ok":true,"result":{"message_id":8080}}`))
		case r.URL.Path == "/webhook":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			mu.Lock()
			whPayloads = append(whPayloads, body)
			mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	defer srv.Close()

	aesKey := auth.DeriveAESKey("test-aes-secret-at-least-32-chars!!")
	encTg, _ := auth.EncryptAESGCM(aesKey, []byte(`{"bot_token":"123:ABC","chat_id":"-1001"}`))
	encWh, _ := auth.EncryptAESGCM(aesKey, []byte(`{"webhook_url":"`+srv.URL+`/webhook"}`))

	p1 := uuid.New()
	t1 := uuid.New()
	t0 := time.Date(2026, 11, 17, 7, 0, 0, 0, time.UTC)
	now := t0

	store := &fakeAlertStore{
		probes:  []db.Probe{{ID: p1, Name: "Probe-JKT", Status: "online"}},
		targets: []db.Target{{ID: t1, Name: "Edge-1", Host: "10.1.1.1", IntervalSec: 1, Enabled: true, AssignAllProbes: true}},
		channels: []db.AlertChannel{
			{ID: uuid.New(), Type: "webhook", Name: "Discord", ConfigEncrypted: encWh, SeverityFilter: "all", Enabled: true},
			{ID: uuid.New(), Type: "telegram", Name: "NOC Tg", ConfigEncrypted: encTg, SeverityFilter: "all", Enabled: true},
		},
		rules: []db.AlertRule{
			{
				ID:              uuid.New(),
				Name:            "Multi-Channel Rule",
				TargetID:        &t1,
				Metric:          "loss_pct",
				ThresholdValue:  20,
				DurationSec:     30,
				QuorumMinProbes: 1,
				CooldownSec:     0,
				ConfirmSec:      1,
				RecoverSec:      0,
				Enabled:         true,
			},
		},
	}

	cache := ingest.NewRollingCache(10 * time.Minute)
	rtt := int32(15000)
	ev := NewEvaluator(store, cache, nil, NewNotifierWithHTTP(srv.Client(), srv.URL), aesKey, func() time.Time { return now })
	ev.SetSyncDispatch(true)

	// Scenario A: Webhook succeeds on WARN, Telegram fails, then escalates to DOWN before Telegram recovers!
	failTelegram.Store(true)
	for i := 0; i < 4; i++ {
		cache.Add(p1, t1, now.Add(time.Duration(i-5)*time.Second), &rtt, 500, i == 0, now) // 25% WARN
	}
	_ = ev.EvaluateOnce(context.Background())

	now = t0.Add(2 * time.Second)
	for i := 0; i < 4; i++ {
		cache.Add(p1, t1, now.Add(time.Duration(i-5)*time.Second), &rtt, 500, i == 0, now)
	}
	_ = ev.EvaluateOnce(context.Background()) // Webhook gets WARN, Telegram fails -> LastNotifiedAt == nil
	if len(whPayloads) != 1 || len(tgMsgs) != 0 || store.incidents[0].LastNotifiedAt != nil {
		t.Fatalf("expected 1 webhook WARN, 0 telegram, LastNotifiedAt=nil; got wh=%d tg=%d notified=%v", len(whPayloads), len(tgMsgs), store.incidents[0].LastNotifiedAt)
	}

	// Now target goes 100% DOWN -> confirm escalation after 1s, Telegram still failing first then recovers
	now = t0.Add(10 * time.Second)
	for i := 0; i < 35; i++ {
		cache.Add(p1, t1, now.Add(-time.Duration(i)*time.Second), nil, 0, true, now)
	}
	_ = ev.EvaluateOnce(context.Background()) // starts escalateSince

	failTelegram.Store(false)
	now = t0.Add(12 * time.Second)
	for i := 0; i < 35; i++ {
		cache.Add(p1, t1, now.Add(-time.Duration(i)*time.Second), nil, 0, true, now)
	}
	_ = ev.EvaluateOnce(context.Background())

	// Webhook must get 1 WARN + 1 ESCALATED DOWN (no duplicate WARN!), Telegram must get 1 DOWN FIRING!
	if len(whPayloads) != 2 || len(tgMsgs) != 1 {
		t.Fatalf("expected wh=2 (WARN + ESCALATED) and tg=1 (DOWN), got wh=%d tg=%d", len(whPayloads), len(tgMsgs))
	}
	whEvent1, _ := whPayloads[1]["smoker_event"].(map[string]any)
	if whEvent1["status"] != "ESCALATED" {
		t.Fatalf("expected second webhook payload to be ESCALATED, got %+v", whEvent1)
	}
	if !strings.Contains(tgMsgs[0], "❌ <b>[DOWN]") || store.incidents[0].LastNotifiedAt == nil {
		t.Fatalf("expected Telegram to receive DOWN and mark incident notified, got tg=%q notified=%v", tgMsgs[0], store.incidents[0].LastNotifiedAt)
	}

	// Mute target AFTER incident already notified, then recover -> pre-mute incident still delivers [OK]
	muteUntil := now.Add(1 * time.Hour)
	store.targets[0].MutedUntil = &muteUntil

	now = t0.Add(45 * time.Second)
	for i := 0; i < 35; i++ {
		cache.Add(p1, t1, now.Add(-time.Duration(i)*time.Second), &rtt, 500, false, now)
	}
	_ = ev.EvaluateOnce(context.Background())
	if len(tgMsgs) != 2 || !strings.Contains(tgMsgs[1], "✅ <b>[OK]") || len(whPayloads) != 3 {
		t.Fatalf("expected pre-mute incident recovery [OK] on both channels, got tg=%d wh=%d", len(tgMsgs), len(whPayloads))
	}

	// Scenario B: Partial initial failure followed by immediate recovery (Telegram failed, Webhook succeeded -> no orphan [OK] on Telegram)
	store.targets[0].MutedUntil = nil
	whPayloads = nil
	tgMsgs = nil
	failTelegram.Store(true)

	now = t0.Add(80 * time.Second)
	for i := 0; i < 35; i++ {
		cache.Add(p1, t1, now.Add(-time.Duration(i)*time.Second), nil, 0, true, now)
	}
	_ = ev.EvaluateOnce(context.Background()) // starts pendingSince
	now = t0.Add(82 * time.Second)
	for i := 0; i < 35; i++ {
		cache.Add(p1, t1, now.Add(-time.Duration(i)*time.Second), nil, 0, true, now)
	}
	_ = ev.EvaluateOnce(context.Background()) // Webhook succeeds, Telegram fails (LastNotifiedAt == nil)
	if len(whPayloads) != 1 || len(tgMsgs) != 0 {
		t.Fatalf("expected wh=1 tg=0 before recovery, got wh=%d tg=%d", len(whPayloads), len(tgMsgs))
	}

	failTelegram.Store(false)
	now = t0.Add(120 * time.Second)
	for i := 0; i < 35; i++ {
		cache.Add(p1, t1, now.Add(-time.Duration(i)*time.Second), &rtt, 500, false, now)
	}
	_ = ev.EvaluateOnce(context.Background())
	if len(whPayloads) != 2 || len(tgMsgs) != 0 {
		t.Fatalf("expected [OK] sent only to webhook (2 total) and 0 orphan [OK] to telegram, got wh=%d tg=%d", len(whPayloads), len(tgMsgs))
	}
}

func TestLatencyP95AutoBestPathPerProbeResolution(t *testing.T) {
	t.Parallel()

	pJKT := uuid.New()
	pSGP := uuid.New()
	tgt := db.Target{
		ID:            uuid.New(),
		Name:          "Edge-Gateway",
		Host:          "1.1.1.1",
		IntervalSec:   5,
		TimeoutMs:     1000,
		LatencyWarnMs: 0,
		ProbeLatencyOverrides: map[string]int{
			pSGP.String(): 40,
		},
		Enabled:         true,
		AssignAllProbes: true,
	}

	// Priority check: probe override > target warn > baseline P25 > timeout*0.5
	if got := ResolveProbeWarnMs(tgt, pSGP, ingest.WindowStats{BaselineMs: 28}); got != 40 {
		t.Fatalf("expected override 40ms for SGP, got %v", got)
	}
	if got := ResolveProbeWarnMs(tgt, pJKT, ingest.WindowStats{BaselineMs: 8}); got != 23 {
		t.Fatalf("expected auto max(8*2, 8+15)=23ms for JKT, got %v", got)
	}
	if got := ResolveProbeWarnMs(tgt, pJKT, ingest.WindowStats{}); got != 500 {
		t.Fatalf("expected fallback timeout*0.5=500ms without baseline, got %v", got)
	}
	tgtWithGlobalWarn := tgt
	tgtWithGlobalWarn.LatencyWarnMs = 15
	if got := ResolveProbeWarnMs(tgtWithGlobalWarn, pJKT, ingest.WindowStats{BaselineMs: 8}); got != 15 {
		t.Fatalf("expected target LatencyWarnMs=15ms over auto baseline, got %v", got)
	}
	if got := ResolveProbeWarnMs(tgtWithGlobalWarn, pSGP, ingest.WindowStats{BaselineMs: 28}); got != 40 {
		t.Fatalf("expected per-probe override 40ms over target LatencyWarnMs, got %v", got)
	}

	var mu sync.Mutex
	var tgMsgs []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		txt, _ := body["text"].(string)
		mu.Lock()
		tgMsgs = append(tgMsgs, txt)
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true,"result":{"message_id":9191}}`))
	}))
	defer srv.Close()

	aesKey := auth.DeriveAESKey("test-aes-secret-at-least-32-chars!!")
	encTg, _ := auth.EncryptAESGCM(aesKey, []byte(`{"bot_token":"123:ABC","chat_id":"-1001"}`))
	store := &fakeAlertStore{
		probes: []db.Probe{
			{ID: pJKT, Name: "Probe-JKT", Status: "online"},
			{ID: pSGP, Name: "Probe-SGP", Status: "online"},
		},
		targets: []db.Target{tgt},
		channels: []db.AlertChannel{
			{ID: uuid.New(), Type: "telegram", Name: "NOC Tg", ConfigEncrypted: encTg, SeverityFilter: "all", Enabled: true},
		},
		rules: []db.AlertRule{
			{
				ID:              uuid.New(),
				Name:            "Auto Best-Path RTT",
				TargetID:        &tgt.ID,
				Metric:          "latency_p95",
				ThresholdValue:  0, // Auto Best-Path
				DurationSec:     30,
				QuorumMinProbes: 1,
				CooldownSec:     0,
				ConfirmSec:      1,
				RecoverSec:      0,
				Enabled:         true,
			},
		},
	}

	t0 := time.Date(2026, 11, 18, 10, 0, 0, 0, time.UTC)
	now := t0
	cache := ingest.NewRollingCache(10 * time.Minute)
	ev := NewEvaluator(store, cache, nil, NewNotifierWithHTTP(srv.Client(), srv.URL), aesKey, func() time.Time { return now })
	ev.SetSyncDispatch(true)

	// Seed Best-Path baseline: JKT 8ms (warn 23ms), SGP 28ms (override 40ms)
	jktBase := int32(8000)
	sgpBase := int32(28000)
	for i := 0; i < 20; i++ {
		ts := t0.Add(-5*time.Minute + time.Duration(i)*5*time.Second)
		cache.Add(pJKT, tgt.ID, ts, &jktBase, 200, false, now)
		cache.Add(pSGP, tgt.ID, ts, &sgpBase, 200, false, now)
	}

	// Spike JKT to 26ms (>= 23ms warn) while SGP sits healthy at 35ms (< 40ms override)
	jktSpike := int32(26000)
	sgpNormal := int32(35000)
	for i := 0; i < 4; i++ {
		ts := now.Add(-time.Duration(i*5) * time.Second)
		cache.Add(pJKT, tgt.ID, ts, &jktSpike, 500, false, now)
		cache.Add(pSGP, tgt.ID, ts, &sgpNormal, 500, false, now)
	}
	_ = ev.EvaluateOnce(context.Background())

	now = t0.Add(2 * time.Second)
	for i := 0; i < 4; i++ {
		ts := now.Add(-time.Duration(i*5) * time.Second)
		cache.Add(pJKT, tgt.ID, ts, &jktSpike, 500, false, now)
		cache.Add(pSGP, tgt.ID, ts, &sgpNormal, 500, false, now)
	}
	_ = ev.EvaluateOnce(context.Background())

	if len(tgMsgs) != 1 {
		t.Fatalf("expected 1 Telegram alert from JKT dynamic best-path breach, got %d", len(tgMsgs))
	}
	if !strings.Contains(tgMsgs[0], "normal &lt; 23 ms") || strings.Contains(tgMsgs[0], "normal &lt; 0 ms") {
		t.Fatalf("expected Telegram message to display resolved 23 ms threshold (never 0 ms), got:\n%s", tgMsgs[0])
	}
	if len(store.incidents) != 1 || len(store.incidents[0].AffectedProbes) != 1 || store.incidents[0].AffectedProbes[0] != "Probe-JKT" {
		t.Fatalf("expected only Probe-JKT to breach its threshold, got %+v", store.incidents)
	}
}


