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
