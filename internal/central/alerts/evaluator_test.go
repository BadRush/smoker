package alerts

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

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

func TestNotifierTelegramAndWebhook(t *testing.T) {
	t.Parallel()

	var gotTelegramPath string
	var gotTelegramPayloads []map[string]any
	var gotWebhookContent string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/bot"):
			gotTelegramPath = r.URL.Path
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			gotTelegramPayloads = append(gotTelegramPayloads, body)
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
	msg := AlertMessage{
		Status:         "FIRING",
		RuleName:       "High Loss",
		TargetName:     "Core Router",
		Metric:         "loss_pct",
		QuorumCount:    2,
		QuorumRequired: 2,
		AffectedProbes: []string{"Probe-A", "Probe-B"},
		Summary:        "loss >= 20%",
		Timestamp:      "2026-11-15T06:00:00Z",
	}

	if err := n.SendTelegram(context.Background(), "123:ABC", "-100999", 0, msg); err != nil {
		t.Fatalf("SendTelegram failed: %v", err)
	}
	if !strings.Contains(gotTelegramPath, "/bot123:ABC/sendMessage") {
		t.Fatalf("unexpected telegram path: %s", gotTelegramPath)
	}
	if _, exists := gotTelegramPayloads[0]["message_thread_id"]; exists {
		t.Fatalf("expected message_thread_id omitted when threadID=0, got %+v", gotTelegramPayloads[0])
	}

	if err := n.SendTelegram(context.Background(), "123:ABC", "-100999", 4281, msg); err != nil {
		t.Fatalf("SendTelegram with threadID failed: %v", err)
	}
	if got, ok := gotTelegramPayloads[1]["message_thread_id"].(float64); !ok || int64(got) != 4281 {
		t.Fatalf("expected message_thread_id=4281, got %+v", gotTelegramPayloads[1])
	}

	if err := n.SendWebhook(context.Background(), srv.URL+"/webhook", msg); err != nil {
		t.Fatalf("SendWebhook failed: %v", err)
	}
	if !strings.Contains(gotWebhookContent, "High Loss") {
		t.Fatalf("unexpected webhook content: %s", gotWebhookContent)
	}
}
