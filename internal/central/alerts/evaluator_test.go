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
			name: "single probe failure does not trigger quorum=2",
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
			_, _ = w.Write([]byte(`{"ok":true}`))
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
		StartedAt:      "2026-11-17T04:30:00Z",
		Timestamp:      "2026-11-17T04:30:00Z",
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
		!strings.Contains(text0, "Start:</b> 17 Nov 2026 11:30:00 WIB") {
		t.Fatalf("unexpected DOWN telegram text:\n%s", text0)
	}
	for _, forbidden := range []string{"🔴", "🟢", "🧪", "Quorum", "FIRING"} {
		if strings.Contains(text0, forbidden) {
			t.Fatalf("telegram text contains forbidden token %q:\n%s", forbidden, text0)
		}
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
	mu        sync.Mutex
	rules     []db.AlertRule
	probes    []db.Probe
	targets   []db.Target
	channels  []db.AlertChannel
	incidents []db.Incident
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
		ID:             uuid.New(),
		RuleID:         ruleID,
		TargetID:       targetID,
		Status:         "open",
		Severity:       severity,
		AffectedProbes: affectedProbes,
		PeakValue:      peak,
		StartedAt:      now,
		Summary:        summary,
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
func (f *fakeAlertStore) MarkIncidentNotified(_ context.Context, id uuid.UUID, now time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i, inc := range f.incidents {
		if inc.ID == id {
			t := now
			inc.LastNotifiedAt = &t
			f.incidents[i] = inc
			break
		}
	}
	return nil
}

func TestEvaluatorEscalationOfflineGuardAndChannelRouting(t *testing.T) {
	t.Parallel()

	var mu sync.Mutex
	sentByThread := make(map[int64][]string)
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
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
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

	// Cycle 1: 25% loss -> sends [WARN] only to ch1 (thread 101), not thread 202
	if err := ev.EvaluateOnce(context.Background()); err != nil {
		t.Fatalf("EvaluateOnce cycle 1: %v", err)
	}
	if len(sentByThread[101]) != 1 || len(sentByThread[202]) != 0 {
		t.Fatalf("expected 1 message in thread 101 and 0 in 202, got 101=%d 202=%d", len(sentByThread[101]), len(sentByThread[202]))
	}
	if !strings.Contains(sentByThread[101][0], "⚠️ <b>[WARN]") {
		t.Fatalf("expected [WARN] message, got:\n%s", sentByThread[101][0])
	}

	// Cycle 2 at +10s with same severity and CooldownSec=0 -> NO duplicate notification
	now = now.Add(10 * time.Second)
	for i := 0; i < 4; i++ {
		cache.Add(p1ID, t1ID, now.Add(-time.Duration(i+1)*time.Second), &rtt, 1000, i == 0, now)
	}
	if err := ev.EvaluateOnce(context.Background()); err != nil {
		t.Fatalf("EvaluateOnce cycle 2: %v", err)
	}
	if len(sentByThread[101]) != 1 {
		t.Fatalf("expected no duplicate notification when cooldown=0, got %d", len(sentByThread[101]))
	}

	// Cycle 3 at +45s: escalate to 100% loss -> sends 1 [DOWN] escalation notification with Elapsed
	now = t0.Add(45 * time.Second)
	for i := 0; i < 35; i++ {
		cache.Add(p1ID, t1ID, now.Add(-time.Duration(i)*time.Second), nil, 0, true, now)
	}
	if err := ev.EvaluateOnce(context.Background()); err != nil {
		t.Fatalf("EvaluateOnce cycle 3: %v", err)
	}
	if len(sentByThread[101]) != 2 || !strings.Contains(sentByThread[101][1], "❌ <b>[DOWN]") || !strings.Contains(sentByThread[101][1], "Elapsed:</b> 45s") {
		t.Fatalf("expected escalation [DOWN] with Elapsed, got %+v", sentByThread[101])
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

	// Cycle 5 at +125s: Probe back online with healthy samples -> sends [OK] with Start, End, Duration (2m 05s (125s))
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
}
