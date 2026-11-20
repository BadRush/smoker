package db

import (
	"testing"
	"time"
)

func TestResolveRange(t *testing.T) {
	cases := []struct {
		key       string
		window    time.Duration
		bucketSec int
		source    string
	}{
		{"5m", 5 * time.Minute, 1, "raw"},
		{"15m", 15 * time.Minute, 5, "raw"},
		{"1h", time.Hour, 15, "raw"},
		{"3h", 3 * time.Hour, 30, "raw"},
		{"6h", 6 * time.Hour, 60, "raw"},
		{"12h", 12 * time.Hour, 60, "agg_1m"},
		{"24h", 24 * time.Hour, 60, "agg_1m"},
		{"3d", 3 * 24 * time.Hour, 300, "agg_5m"},
		{"7d", 7 * 24 * time.Hour, 300, "agg_5m"},
		{"30d", 30 * 24 * time.Hour, 3600, "agg_1h"},
		{"1y", 365 * 24 * time.Hour, 21600, "agg_6h"},
		{"unknown", 5 * time.Minute, 1, "raw"},
	}

	for _, tc := range cases {
		got := resolveRange(tc.key)
		if got.window != tc.window || got.bucketSec != tc.bucketSec || got.source != tc.source {
			t.Errorf("resolveRange(%q) = %+v, want {window:%v bucketSec:%d source:%s}",
				tc.key, got, tc.window, tc.bucketSec, tc.source)
		}
	}
}

func TestResolveCustomWindowSpec(t *testing.T) {
	now := time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name      string
		from      time.Time
		to        time.Time
		bucketSec int
		source    string
	}{
		{"recent_5m_raw_1s", now.Add(-5 * time.Minute), now, 1, "raw"},
		{"recent_2h_raw", now.Add(-4 * time.Hour), now.Add(-2 * time.Hour), 30, "raw"},
		{"old_2h_past_raw_retention", now.Add(-20 * 24 * time.Hour), now.Add(-20*24*time.Hour + 2*time.Hour), 60, "agg_1m"},
		{"day_span", now.Add(-36 * time.Hour), now.Add(-12 * time.Hour), 60, "agg_1m"},
		{"three_day_span", now.Add(-3 * 24 * time.Hour), now, 300, "agg_5m"},
		{"thirty_day_span", now.Add(-30 * 24 * time.Hour), now, 3600, "agg_1h"},
		{"ninety_day_span", now.Add(-90 * 24 * time.Hour), now, 21600, "agg_6h"},
	}
	for _, tc := range cases {
		got := resolveCustomWindowSpec(tc.from, tc.to, now)
		if got.bucketSec != tc.bucketSec || got.source != tc.source {
			t.Errorf("%s: got {bucketSec:%d source:%s}, want {bucketSec:%d source:%s}",
				tc.name, got.bucketSec, got.source, tc.bucketSec, tc.source)
		}
	}
}
