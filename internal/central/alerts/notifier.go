package alerts

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type ChannelSecret struct {
	BotToken   string `json:"bot_token,omitempty"`
	ChatID     string `json:"chat_id,omitempty"`
	WebhookURL string `json:"webhook_url,omitempty"`
}

type Notifier struct {
	client          *http.Client
	telegramBaseURL string
}

func NewNotifier() *Notifier {
	return &Notifier{
		client: &http.Client{
			Timeout: 6 * time.Second,
		},
		telegramBaseURL: "https://api.telegram.org",
	}
}

func NewNotifierWithHTTP(client *http.Client, telegramBaseURL string) *Notifier {
	return &Notifier{
		client:          client,
		telegramBaseURL: strings.TrimRight(telegramBaseURL, "/"),
	}
}

type AlertMessage struct {
	Status         string   `json:"status"` // FIRING | RESOLVED | TEST
	RuleName       string   `json:"rule_name"`
	TargetName     string   `json:"target_name"`
	Metric         string   `json:"metric"`
	Value          float64  `json:"value"`
	Threshold      float64  `json:"threshold"`
	QuorumCount    int      `json:"quorum_count"`
	QuorumRequired int      `json:"quorum_required"`
	AffectedProbes []string `json:"affected_probes"`
	Summary        string   `json:"summary"`
	Timestamp      string   `json:"timestamp"`
}

func (n *Notifier) SendTelegram(ctx context.Context, botToken, chatID string, msg AlertMessage) error {
	if botToken == "" || chatID == "" {
		return fmt.Errorf("telegram bot_token and chat_id required")
	}

	emoji := "🔴"
	if msg.Status == "RESOLVED" {
		emoji = "🟢"
	} else if msg.Status == "TEST" {
		emoji = "🧪"
	}

	text := fmt.Sprintf(
		"%s *Smoker Alert [%s]*\n*Rule:* %s\n*Target:* %s\n*Quorum:* %d/%d probes\n*Detail:* %s\n*Time:* %s",
		emoji,
		escapeMarkdown(msg.Status),
		escapeMarkdown(msg.RuleName),
		escapeMarkdown(msg.TargetName),
		msg.QuorumCount,
		msg.QuorumRequired,
		escapeMarkdown(msg.Summary),
		escapeMarkdown(msg.Timestamp),
	)

	payload := map[string]any{
		"chat_id":    chatID,
		"text":       text,
		"parse_mode": "Markdown",
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	endpoint := fmt.Sprintf("%s/bot%s/sendMessage", n.telegramBaseURL, url.PathEscape(botToken))
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
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
		return fmt.Errorf("telegram status %d: %s", resp.StatusCode, strings.TrimSpace(string(respBody)))
	}
	return nil
}

func (n *Notifier) SendWebhook(ctx context.Context, webhookURL string, msg AlertMessage) error {
	if webhookURL == "" {
		return fmt.Errorf("webhook_url required")
	}

	// Discord-compatible + generic structured JSON payload
	color := 0xF43F5E // Rose
	if msg.Status == "RESOLVED" {
		color = 0x10B981 // Emerald
	} else if msg.Status == "TEST" {
		color = 0x06B6D4 // Cyan
	}

	payload := map[string]any{
		"content": fmt.Sprintf("[%s] %s — %s (%s)", msg.Status, msg.RuleName, msg.TargetName, msg.Summary),
		"embeds": []map[string]any{
			{
				"title":       fmt.Sprintf("Smoker %s: %s", msg.Status, msg.RuleName),
				"description": msg.Summary,
				"color":       color,
				"fields": []map[string]any{
					{"name": "Target", "value": msg.TargetName, "inline": true},
					{"name": "Quorum", "value": fmt.Sprintf("%d / %d", msg.QuorumCount, msg.QuorumRequired), "inline": true},
					{"name": "Affected Probes", "value": strings.Join(msg.AffectedProbes, ", "), "inline": false},
				},
				"timestamp": msg.Timestamp,
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

func escapeMarkdown(s string) string {
	replacer := strings.NewReplacer("_", "\\_", "*", "\\*", "`", "\\`", "[", "\\[")
	return replacer.Replace(s)
}
