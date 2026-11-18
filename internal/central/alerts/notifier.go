package alerts

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"smoker/internal/central/db"
)

type ChannelSecret struct {
	BotToken   string `json:"bot_token,omitempty"`
	ChatID     string `json:"chat_id,omitempty"`
	ThreadID   int64  `json:"thread_id,omitempty"`
	WebhookURL string `json:"webhook_url,omitempty"`
}

type ProbeAlertStat struct {
	ProbeName        string  `json:"probe_name"`
	LossPct          float64 `json:"loss_pct"`
	P95Ms            float64 `json:"p95_ms,omitempty"`
	AvgJitterMs      float64 `json:"avg_jitter_ms,omitempty"`
	BaselineMs       float64 `json:"baseline_ms,omitempty"`
	BaselineSpikePct float64 `json:"baseline_spike_pct,omitempty"`
	OfflineSec       float64 `json:"offline_sec,omitempty"`
}

type chatPacer struct {
	mu            sync.Mutex
	nextAllowedAt time.Time
}

type Notifier struct {
	client          *http.Client
	telegramBaseURL string
	minChatInterval time.Duration
	nowFn           func() time.Time
	afterFn         func(time.Duration) <-chan time.Time

	chatMu    sync.Mutex
	chatLocks map[string]*chatPacer
}

func NewNotifier() *Notifier {
	return &Notifier{
		client: &http.Client{
			Timeout: 10 * time.Second,
		},
		telegramBaseURL: "https://api.telegram.org",
		minChatInterval: 80 * time.Millisecond,
		nowFn:           time.Now,
		afterFn:         time.After,
		chatLocks:       make(map[string]*chatPacer),
	}
}

func NewNotifierWithHTTP(client *http.Client, telegramBaseURL string) *Notifier {
	return &Notifier{
		client:          client,
		telegramBaseURL: strings.TrimRight(telegramBaseURL, "/"),
		minChatInterval: 20 * time.Millisecond,
		nowFn:           time.Now,
		afterFn:         time.After,
		chatLocks:       make(map[string]*chatPacer),
	}
}

func (n *Notifier) now() time.Time {
	if n.nowFn != nil {
		return n.nowFn()
	}
	return time.Now()
}

func (n *Notifier) after(d time.Duration) <-chan time.Time {
	if n.afterFn != nil {
		return n.afterFn(d)
	}
	return time.After(d)
}

func (n *Notifier) SetMinChatInterval(d time.Duration) {
	n.chatMu.Lock()
	defer n.chatMu.Unlock()
	n.minChatInterval = d
}

func (n *Notifier) pacerForChat(chatID string) *chatPacer {
	n.chatMu.Lock()
	defer n.chatMu.Unlock()
	if n.chatLocks == nil {
		n.chatLocks = make(map[string]*chatPacer)
	}
	key := strings.TrimSpace(chatID)
	p, ok := n.chatLocks[key]
	if !ok {
		p = &chatPacer{}
		n.chatLocks[key] = p
	}
	return p
}

type AlertMessage struct {
	IncidentID       uuid.UUID        `json:"incident_id,omitempty"`
	IncidentSeverity string           `json:"incident_severity,omitempty"`
	Status           string           `json:"status"`   // FIRING | ESCALATED | RESOLVED | TEST
	Severity         string           `json:"severity"` // critical | warn | ok | test
	RuleName         string           `json:"rule_name"`
	TargetName       string           `json:"target_name"`
	TargetHost       string           `json:"target_host,omitempty"`
	Metric           string           `json:"metric"`
	Value            float64          `json:"value"`
	PeakValue        float64          `json:"peak_value,omitempty"`
	Threshold        float64          `json:"threshold"`
	QuorumCount      int              `json:"quorum_count"`
	QuorumRequired   int              `json:"quorum_required"`
	TotalProbes      int              `json:"total_probes,omitempty"`
	AffectedProbes   []string         `json:"affected_probes"`
	ProbeBreakdown   []ProbeAlertStat `json:"probe_breakdown,omitempty"`
	MTRBottleneck    string           `json:"mtr_bottleneck,omitempty"`
	ReplyToMsgID       int64            `json:"reply_to_message_id,omitempty"`
	ReplyToByChannel   map[string]int64 `json:"-"`
	PartialInitialOnly bool             `json:"-"`
	Summary            string           `json:"summary"`
	StartedAt        string           `json:"started_at,omitempty"`
	ResolvedAt       string           `json:"resolved_at,omitempty"`
	DurationSec      int64            `json:"duration_sec,omitempty"`
	Timestamp        string           `json:"timestamp"`
	ChannelIDs       []uuid.UUID      `json:"channel_ids,omitempty"`
}

func (n *Notifier) SendTelegram(ctx context.Context, botToken, chatID string, threadID int64, msg AlertMessage) error {
	_, err := n.SendTelegramWithReply(ctx, botToken, chatID, threadID, msg.ReplyToMsgID, msg)
	return err
}

func (n *Notifier) SendTelegramWithReply(ctx context.Context, botToken, chatID string, threadID int64, replyToMsgID int64, msg AlertMessage) (int64, error) {
	if botToken == "" || chatID == "" {
		return 0, fmt.Errorf("telegram bot_token and chat_id required")
	}
	if replyToMsgID <= 0 && msg.ReplyToMsgID > 0 {
		replyToMsgID = msg.ReplyToMsgID
	}

	text := FormatTelegramHTML(msg)
	payload := map[string]any{
		"chat_id":                  chatID,
		"text":                     text,
		"parse_mode":               "HTML",
		"disable_web_page_preview": true,
	}
	if threadID > 0 {
		payload["message_thread_id"] = threadID
	}
	if replyToMsgID > 0 {
		payload["reply_to_message_id"] = replyToMsgID
		payload["allow_sending_without_reply"] = true
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return 0, err
	}

	endpoint := fmt.Sprintf("%s/bot%s/sendMessage", n.telegramBaseURL, url.PathEscape(botToken))
	pacer := n.pacerForChat(chatID)
	pacer.mu.Lock()
	defer pacer.mu.Unlock()

	for attempt := 0; attempt < 3; attempt++ {
		if waitPacing := pacer.nextAllowedAt.Sub(n.now()); waitPacing > 0 {
			select {
			case <-ctx.Done():
				return 0, ctx.Err()
			case <-n.after(waitPacing):
			}
		}

		req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
		if err != nil {
			return 0, err
		}
		req.Header.Set("Content-Type", "application/json")

		resp, err := n.client.Do(req)
		if err != nil {
			return 0, err
		}
		respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		_ = resp.Body.Close()

		if resp.StatusCode < 300 {
			if n.minChatInterval > 0 {
				pacer.nextAllowedAt = n.now().Add(n.minChatInterval)
			}
			var tgResp struct {
				OK     bool `json:"ok"`
				Result struct {
					MessageID int64 `json:"message_id"`
				} `json:"result"`
			}
			if err := json.Unmarshal(respBody, &tgResp); err == nil && tgResp.Result.MessageID > 0 {
				return tgResp.Result.MessageID, nil
			}
			return 0, nil
		}

		if resp.StatusCode == http.StatusTooManyRequests && attempt < 2 {
			wait := parseTelegramRetryAfter(resp.Header.Get("Retry-After"), respBody)
			if wait <= 0 {
				wait = time.Second
			}
			pacer.nextAllowedAt = n.now().Add(wait)
			select {
			case <-ctx.Done():
				return 0, ctx.Err()
			case <-n.after(wait):
				pacer.nextAllowedAt = time.Time{}
				continue
			}
		}

		return 0, fmt.Errorf("telegram status %d: %s", resp.StatusCode, strings.TrimSpace(string(respBody)))
	}
	return 0, fmt.Errorf("telegram send failed after retries")
}

func parseTelegramRetryAfter(headerVal string, body []byte) time.Duration {
	if secs, err := strconv.Atoi(strings.TrimSpace(headerVal)); err == nil && secs > 0 {
		return time.Duration(secs) * time.Second
	}
	var tgErr struct {
		Parameters struct {
			RetryAfter int `json:"retry_after"`
		} `json:"parameters"`
	}
	if err := json.Unmarshal(body, &tgErr); err == nil && tgErr.Parameters.RetryAfter > 0 {
		return time.Duration(tgErr.Parameters.RetryAfter) * time.Second
	}
	return 0
}

// SummarizeMTRBottleneck extracts a concise bottleneck or final hop summary from recent MTR snapshots
// captured during (or up to 2 minutes before) the active incident window.
func SummarizeMTRBottleneck(snaps []db.MTRSnapshot, incidentStart time.Time) string {
	for _, snap := range snaps {
		if len(snap.Hops) == 0 {
			continue
		}
		if !incidentStart.IsZero() && snap.CapturedAt.Before(incidentStart.Add(-2*time.Minute)) {
			continue
		}
		hops := snap.Hops
		chosen := hops[len(hops)-1]
		foundLoss := false
		for _, h := range hops {
			responding := (h.IP != "" && h.IP != "*") || h.Host != ""
			if h.LossPct > 0 && responding {
				if !foundLoss || h.LossPct > chosen.LossPct || (h.LossPct == chosen.LossPct && h.Hop > chosen.Hop) {
					chosen = h
					foundLoss = true
				}
			}
		}
		if !foundLoss {
			lastHop := hops[len(hops)-1]
			lastResponding := (lastHop.IP != "" && lastHop.IP != "*") || lastHop.Host != ""
			if !lastResponding && lastHop.LossPct > 0 {
				chosen = lastHop
				foundLoss = true
			}
		}
		if !foundLoss {
			for _, h := range hops {
				responding := (h.IP != "" && h.IP != "*") || h.Host != ""
				if responding && h.AvgUs > chosen.AvgUs {
					chosen = h
				}
			}
		}

		hostIP := strings.TrimSpace(chosen.Host)
		ip := strings.TrimSpace(chosen.IP)
		if hostIP == "" {
			hostIP = ip
		} else if ip != "" && !strings.EqualFold(hostIP, ip) {
			hostIP = fmt.Sprintf("%s / %s", hostIP, ip)
		}
		if hostIP == "" {
			hostIP = "*"
		}

		var parts []string
		if chosen.LossPct > 0 {
			parts = append(parts, fmt.Sprintf("%.0f%% loss", chosen.LossPct))
		} else {
			parts = append(parts, "0% loss")
		}
		if chosen.AvgUs > 0 {
			parts = append(parts, fmt.Sprintf("%.1f ms", float64(chosen.AvgUs)/1000.0))
		}
		return fmt.Sprintf("#%d (%s) — %s", chosen.Hop, hostIP, strings.Join(parts, ", "))
	}
	return ""
}

// FormatTelegramHTML formats alerts using plain non-jargon English, HTML-safe escaping,
// SLA start/end/duration fields, adaptive single-probe vs. multi-probe layout, and strictly only the ❌, ⚠️, and ✅ icons.
func FormatTelegramHTML(msg AlertMessage) string {
	esc := html.EscapeString
	sev := resolveEffectiveSeverity(msg)

	if msg.Status == "TEST" || sev == "test" {
		statusText := strings.TrimSpace(msg.Summary)
		if statusText == "" {
			statusText = "Notification connection verified"
		}
		return strings.Join([]string{
			"⚠️ <b>[TEST] Notification Check</b>",
			fmt.Sprintf("<b>Status:</b> %s", esc(statusText)),
			fmt.Sprintf("<b>Time:</b> %s", esc(formatAlertTimestamp(msg.Timestamp))),
		}, "\n")
	}

	targetDisplay := formatTargetDisplay(msg.TargetName, msg.TargetHost)
	locations := strings.Join(msg.AffectedProbes, ", ")
	if locations == "" {
		locations = "All assigned locations"
	}

	total := msg.TotalProbes
	if total < msg.QuorumCount {
		total = msg.QuorumCount
	}
	if total < len(msg.AffectedProbes) {
		total = len(msg.AffectedProbes)
	}
	isSingleProbe := total <= 1 && len(msg.AffectedProbes) == 1

	if msg.Status == "RESOLVED" || sev == "ok" {
		headerTitle := fmt.Sprintf("%s — Connection Restored", targetDisplay)
		if msg.Metric == "probe_offline" {
			headerTitle = "Monitoring Probes — Back Online"
		}
		lines := []string{
			fmt.Sprintf("✅ <b>[OK] %s</b>", esc(headerTitle)),
		}
		if msg.RuleName != "" {
			lines = append(lines, fmt.Sprintf("<b>Alert:</b> %s", esc(msg.RuleName)))
		}
		lines = append(lines, fmt.Sprintf("<b>Target:</b> %s", esc(targetDisplay)))

		startStr := formatAlertTimestamp(firstNonEmpty(msg.StartedAt, msg.Timestamp))
		endStr := formatAlertTimestamp(firstNonEmpty(msg.ResolvedAt, msg.Timestamp))
		lines = append(lines,
			fmt.Sprintf("<b>Start:</b> %s", esc(startStr)),
			fmt.Sprintf("<b>End:</b> %s", esc(endStr)),
		)

		peakVal := msg.PeakValue
		if peakVal <= 0 {
			peakVal = msg.Value
		}
		durationLine := FormatDurationSLA(msg.DurationSec)
		if peakText := formatPeakLabel(msg.Metric, peakVal); peakText != "" {
			durationLine = fmt.Sprintf("%s | Peak: %s", durationLine, peakText)
		}
		lines = append(lines, fmt.Sprintf("<b>Duration:</b> %s", esc(durationLine)))
		if isSingleProbe {
			lines = append(lines, fmt.Sprintf("<b>Probe:</b> %s", esc(msg.AffectedProbes[0])))
		} else {
			lines = append(lines, fmt.Sprintf("<b>Locations:</b> %s", esc(locations)))
		}
		if mtr := strings.TrimSpace(msg.MTRBottleneck); mtr != "" {
			lines = append(lines, fmt.Sprintf("<b>MTR Hop:</b> %s", esc(mtr)))
		}
		return strings.Join(lines, "\n")
	}

	icon := "⚠️"
	tag := "WARN"
	if sev == "critical" {
		icon = "❌"
		tag = "DOWN"
	}
	headerSuffix := ""
	if msg.Status == "ESCALATED" {
		headerSuffix = " (Escalated)"
	}

	lines := []string{
		fmt.Sprintf("%s <b>[%s] %s%s</b>", icon, tag, esc(targetDisplay), esc(headerSuffix)),
	}
	if msg.RuleName != "" {
		lines = append(lines, fmt.Sprintf("<b>Alert:</b> %s", esc(msg.RuleName)))
	}

	condLine := formatPlainCondition(msg)
	if msg.DurationSec == 0 && msg.PeakValue > msg.Value {
		if peakText := formatPeakLabel(msg.Metric, msg.PeakValue); peakText != "" {
			condLine = fmt.Sprintf("%s | Peak: %s", condLine, peakText)
		}
	}
	lines = append(lines,
		fmt.Sprintf("<b>Target:</b> %s", esc(targetDisplay)),
		fmt.Sprintf("<b>Condition:</b> %s", esc(condLine)),
	)

	if isSingleProbe {
		probeName := msg.AffectedProbes[0]
		detail := formatSingleProbeDetail(msg, probeName)
		if detail != "" {
			lines = append(lines, fmt.Sprintf("<b>Probe:</b> %s (%s)", esc(probeName), esc(detail)))
		} else {
			lines = append(lines, fmt.Sprintf("<b>Probe:</b> %s", esc(probeName)))
		}
	} else {
		if msg.QuorumCount > 0 && total > 0 {
			lines = append(lines, fmt.Sprintf("<b>Detected from:</b> %d of %d locations (%s)", msg.QuorumCount, total, esc(locations)))
		} else {
			lines = append(lines, fmt.Sprintf("<b>Detected from:</b> %s", esc(locations)))
		}
		if len(msg.ProbeBreakdown) > 0 {
			lines = append(lines, "<b>Probe Breakdown:</b>")
			for _, pb := range msg.ProbeBreakdown {
				detail := formatProbeStatDetail(msg.Metric, pb)
				if detail != "" {
					lines = append(lines, fmt.Sprintf("• %s: %s", esc(pb.ProbeName), esc(detail)))
				} else {
					lines = append(lines, fmt.Sprintf("• %s", esc(pb.ProbeName)))
				}
			}
		}
	}

	if mtr := strings.TrimSpace(msg.MTRBottleneck); mtr != "" {
		lines = append(lines, fmt.Sprintf("<b>MTR Hop:</b> %s", esc(mtr)))
	}

	startTime := firstNonEmpty(msg.StartedAt, msg.Timestamp)
	lines = append(lines, fmt.Sprintf("<b>Start:</b> %s", esc(formatAlertTimestamp(startTime))))

	if msg.Status == "ESCALATED" || msg.DurationSec > 0 {
		elapsedLine := FormatDurationSLA(msg.DurationSec)
		if msg.PeakValue > msg.Value {
			if peakText := formatPeakLabel(msg.Metric, msg.PeakValue); peakText != "" {
				elapsedLine = fmt.Sprintf("%s | Peak: %s", elapsedLine, peakText)
			}
		}
		lines = append(lines,
			fmt.Sprintf("<b>Elapsed:</b> %s", esc(elapsedLine)),
			fmt.Sprintf("<b>Updated:</b> %s", esc(formatAlertTimestamp(msg.Timestamp))),
		)
	}
	return strings.Join(lines, "\n")
}

func formatProbeStatDetail(metric string, st ProbeAlertStat) string {
	if metric == "probe_offline" || st.OfflineSec > 0 {
		return fmt.Sprintf("offline %s", formatDurationCompact(int64(st.OfflineSec)))
	}
	if st.LossPct >= 99.9 {
		return "100% loss"
	}
	var parts []string
	if st.LossPct > 0 {
		parts = append(parts, fmt.Sprintf("%.1f%% loss", st.LossPct))
	} else if metric == "loss_pct" {
		parts = append(parts, "0% loss")
	}
	if st.P95Ms > 0 {
		parts = append(parts, fmt.Sprintf("P95 %.0f ms", st.P95Ms))
	}
	if metric == "baseline_spike_pct" && st.BaselineSpikePct > 0 {
		if st.BaselineMs > 0 {
			parts = append(parts, fmt.Sprintf("+%.0f%% vs %.0f ms base", st.BaselineSpikePct, st.BaselineMs))
		} else {
			parts = append(parts, fmt.Sprintf("+%.0f%% spike", st.BaselineSpikePct))
		}
	}
	if st.AvgJitterMs > 0 && (metric == "jitter" || st.AvgJitterMs >= 1.0) {
		parts = append(parts, fmt.Sprintf("jitter %.0f ms", st.AvgJitterMs))
	}
	return strings.Join(parts, ", ")
}

func formatSingleProbeDetail(msg AlertMessage, probeName string) string {
	for _, pb := range msg.ProbeBreakdown {
		if pb.ProbeName == probeName {
			if d := formatProbeStatDetail(msg.Metric, pb); d != "" {
				return d
			}
		}
	}
	if len(msg.ProbeBreakdown) == 1 {
		if d := formatProbeStatDetail(msg.Metric, msg.ProbeBreakdown[0]); d != "" {
			return d
		}
	}
	switch msg.Metric {
	case "loss_pct":
		if msg.Value >= 99.9 {
			return "100% loss"
		}
		if msg.Value > 0 {
			return fmt.Sprintf("%.1f%% loss", msg.Value)
		}
	case "latency_p95":
		if msg.Value > 0 {
			return fmt.Sprintf("P95 %.0f ms", msg.Value)
		}
	case "jitter":
		if msg.Value > 0 {
			return fmt.Sprintf("jitter %.0f ms", msg.Value)
		}
	case "baseline_spike_pct":
		if msg.Value > 0 {
			return fmt.Sprintf("+%.0f%% spike", msg.Value)
		}
	case "probe_offline":
		if msg.Value > 0 {
			return fmt.Sprintf("offline %s", formatDurationCompact(int64(msg.Value)))
		}
	}
	return ""
}

func resolveEffectiveSeverity(msg AlertMessage) string {
	switch strings.ToLower(strings.TrimSpace(msg.Severity)) {
	case "critical":
		return "critical"
	case "warn":
		return "warn"
	case "ok":
		return "ok"
	case "test":
		return "test"
	}
	switch msg.Status {
	case "RESOLVED":
		return "ok"
	case "TEST":
		return "test"
	case "ESCALATED":
		return "critical"
	default:
		if msg.Metric == "probe_offline" || (msg.Metric == "loss_pct" && msg.Value >= 50) {
			return "critical"
		}
		return "warn"
	}
}

func formatTargetDisplay(name, host string) string {
	n := strings.TrimSpace(name)
	h := strings.TrimSpace(host)
	if n == "" {
		return h
	}
	if h == "" || strings.EqualFold(n, h) {
		return n
	}
	return fmt.Sprintf("%s (%s)", n, h)
}

func formatPlainCondition(msg AlertMessage) string {
	switch msg.Metric {
	case "loss_pct":
		if msg.Value >= 99.9 {
			return "Connection Down (100% failed)"
		}
		if msg.Value >= 50 {
			return fmt.Sprintf("Severe Connection Loss (%.1f%% failed, limit %.0f%%)", msg.Value, msg.Threshold)
		}
		return fmt.Sprintf("Unstable Connection (%.1f%% packet loss, limit %.0f%%)", msg.Value, msg.Threshold)
	case "latency_p95":
		return fmt.Sprintf("Slow Connection (%.0f ms, normal < %.0f ms)", msg.Value, msg.Threshold)
	case "jitter":
		return fmt.Sprintf("Unstable Speed (%.0f ms variation, normal < %.0f ms)", msg.Value, msg.Threshold)
	case "baseline_spike_pct":
		return fmt.Sprintf("Slower Than Usual (+%.0f%% slower, limit +%.0f%%)", msg.Value, msg.Threshold)
	case "probe_offline":
		return fmt.Sprintf("Monitoring Probe Offline (offline %s)", formatDurationCompact(int64(msg.Value)))
	default:
		if msg.Summary != "" {
			return msg.Summary
		}
		return "Connection issue detected"
	}
}

func formatPeakLabel(metric string, peak float64) string {
	if peak <= 0 {
		return ""
	}
	switch metric {
	case "loss_pct":
		if peak >= 99.9 {
			return "100% failed"
		}
		return fmt.Sprintf("%.1f%% failed", peak)
	case "latency_p95":
		return fmt.Sprintf("%.0f ms", peak)
	case "jitter":
		return fmt.Sprintf("%.0f ms variation", peak)
	case "baseline_spike_pct":
		return fmt.Sprintf("+%.0f%% slower", peak)
	case "probe_offline":
		return fmt.Sprintf("offline %s", formatDurationCompact(int64(peak)))
	default:
		return ""
	}
}

func formatDurationCompact(sec int64) string {
	if sec < 0 {
		sec = 0
	}
	h := sec / 3600
	m := (sec % 3600) / 60
	s := sec % 60
	if h > 0 {
		return fmt.Sprintf("%dh %02dm %02ds", h, m, s)
	}
	if m > 0 {
		return fmt.Sprintf("%dm %02ds", m, s)
	}
	return fmt.Sprintf("%ds", s)
}

func FormatDurationSLA(sec int64) string {
	if sec < 0 {
		sec = 0
	}
	compact := formatDurationCompact(sec)
	if sec < 60 {
		return compact
	}
	return fmt.Sprintf("%s (%ds)", compact, sec)
}

func resolveAlertLocation() (*time.Location, string) {
	tzName := strings.TrimSpace(os.Getenv("ALERT_TIMEZONE"))
	if tzName == "" {
		tzName = strings.TrimSpace(os.Getenv("TZ"))
	}
	if tzName == "" {
		tzName = "Asia/Jakarta"
	}
	loc, err := time.LoadLocation(tzName)
	if err != nil {
		if tzName == "Asia/Jakarta" {
			return time.FixedZone("WIB", 7*3600), "Asia/Jakarta"
		}
		return time.UTC, "UTC"
	}
	return loc, tzName
}

func formatAlertTimestamp(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "-"
	}
	t, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		t, err = time.Parse(time.RFC3339, raw)
		if err != nil {
			return raw
		}
	}
	loc, tzName := resolveAlertLocation()
	localT := t.In(loc)
	zoneAbbr, _ := localT.Zone()
	if tzName == "Asia/Jakarta" && (zoneAbbr == "+07" || zoneAbbr == "") {
		zoneAbbr = "WIB"
	}
	return localT.Format("02 Jan 2006 15:04:05") + " " + zoneAbbr
}

func firstNonEmpty(a, b string) string {
	if strings.TrimSpace(a) != "" {
		return a
	}
	return b
}

func (n *Notifier) SendWebhook(ctx context.Context, webhookURL string, msg AlertMessage) error {
	if webhookURL == "" {
		return fmt.Errorf("webhook_url required")
	}

	sev := resolveEffectiveSeverity(msg)
	color := 0xF59E0B // Amber (WARN)
	tag := "WARN"
	if sev == "critical" {
		color = 0xF43F5E // Rose (DOWN)
		tag = "DOWN"
	} else if msg.Status == "RESOLVED" || sev == "ok" {
		color = 0x10B981 // Emerald (OK)
		tag = "OK"
	} else if msg.Status == "TEST" || sev == "test" {
		color = 0x06B6D4 // Cyan (TEST)
		tag = "TEST"
	}

	desc := msg.Summary
	if desc == "" && msg.Status != "RESOLVED" && msg.Status != "TEST" {
		desc = formatPlainCondition(msg)
	}
	fields := []map[string]any{
		{"name": "Target", "value": formatTargetDisplay(msg.TargetName, msg.TargetHost), "inline": true},
		{"name": "Detected From", "value": strings.Join(msg.AffectedProbes, ", "), "inline": true},
	}
	if msg.PeakValue > 0 {
		if peakText := formatPeakLabel(msg.Metric, msg.PeakValue); peakText != "" {
			fields = append(fields, map[string]any{"name": "Peak", "value": peakText, "inline": true})
		}
	}
	if msg.MTRBottleneck != "" {
		fields = append(fields, map[string]any{"name": "MTR Hop", "value": msg.MTRBottleneck, "inline": false})
	}
	if msg.StartedAt != "" {
		fields = append(fields, map[string]any{"name": "Start", "value": formatAlertTimestamp(msg.StartedAt), "inline": true})
	}
	if msg.Status == "RESOLVED" {
		if msg.ResolvedAt != "" {
			fields = append(fields, map[string]any{"name": "End", "value": formatAlertTimestamp(msg.ResolvedAt), "inline": true})
		}
		fields = append(fields, map[string]any{"name": "Duration", "value": FormatDurationSLA(msg.DurationSec), "inline": true})
	}

	payload := map[string]any{
		"content": fmt.Sprintf("[%s] %s — %s (%s)", tag, msg.RuleName, msg.TargetName, desc),
		"embeds": []map[string]any{
			{
				"title":       fmt.Sprintf("Smoker %s: %s", tag, msg.TargetName),
				"description": desc,
				"color":       color,
				"fields":      fields,
				"timestamp":   msg.Timestamp,
			},
		},
		"smoker_event": msg,
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, webhookURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := n.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return fmt.Errorf("webhook status %d: %s", resp.StatusCode, strings.TrimSpace(string(respBody)))
	}
	return nil
}
