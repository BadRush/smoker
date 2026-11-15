package engine

import (
	"testing"
	"time"
)

func TestLossTrackerConsecutiveAndIntermittentRollingWindow(t *testing.T) {
	t.Parallel()

	t0 := time.Unix(1_700_000_000, 0)
	var lt lossTracker

	// Intermittent pattern: loss, ok, loss, ok, loss -> 3 losses inside 15-sample window triggers Auto MTR!
	if lt.record(true, 3, t0) {
		t.Fatalf("1st loss should not trigger threshold 3")
	}
	if lt.record(false, 3, t0.Add(time.Second)) {
		t.Fatalf("ok sample should not trigger")
	}
	if lt.record(true, 3, t0.Add(2*time.Second)) {
		t.Fatalf("2nd intermittent loss should not trigger threshold 3")
	}
	if lt.record(false, 3, t0.Add(3*time.Second)) {
		t.Fatalf("ok sample should not trigger")
	}
	if !lt.record(true, 3, t0.Add(4*time.Second)) {
		t.Fatalf("3rd intermittent loss inside rolling window should trigger Auto MTR")
	}

	// Inside 2m cooldown, subsequent losses must be suppressed
	if lt.record(true, 3, t0.Add(20*time.Second)) {
		t.Fatalf("expected cooldown to suppress duplicate Auto MTR")
	}

	// After markFailed at t0+5s, retry becomes allowed at t0+5s+31s instead of waiting full 2m
	lt.markFailed(t0.Add(5 * time.Second))
	if lt.record(true, 3, t0.Add(25*time.Second)) {
		t.Fatalf("expected 30s retry backoff to suppress at +20s")
	}
	if !lt.record(true, 3, t0.Add(37*time.Second)) {
		t.Fatalf("expected Auto MTR retry allowed after 30s failure backoff")
	}
}
