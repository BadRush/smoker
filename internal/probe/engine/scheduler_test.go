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
	if ok, _ := lt.record(true, false, 3, t0); ok {
		t.Fatalf("1st loss should not trigger threshold 3")
	}
	if ok, _ := lt.record(false, false, 3, t0.Add(time.Second)); ok {
		t.Fatalf("ok sample should not trigger")
	}
	if ok, _ := lt.record(true, false, 3, t0.Add(2*time.Second)); ok {
		t.Fatalf("2nd intermittent loss should not trigger threshold 3")
	}
	if ok, _ := lt.record(false, false, 3, t0.Add(3*time.Second)); ok {
		t.Fatalf("ok sample should not trigger")
	}
	ok, reason := lt.record(true, false, 3, t0.Add(4*time.Second))
	if !ok || reason != "auto_loss" {
		t.Fatalf("3rd intermittent loss inside rolling window should trigger auto_loss, got ok=%v reason=%q", ok, reason)
	}

	// While continuously impaired, subsequent losses must be suppressed for 15m (edge-triggered anti-spam)
	if ok, _ := lt.record(true, false, 3, t0.Add(5*time.Minute)); ok {
		t.Fatalf("expected 15m ongoing incident lock to suppress duplicate Auto MTR")
	}
	if ok, _ := lt.record(true, false, 3, t0.Add(16*time.Minute)); !ok {
		t.Fatalf("expected 15m repeat interval to allow periodic re-capture during prolonged outage")
	}

	// After markFailed at t0+16m5s, retry becomes allowed after 30s instead of waiting full 15m
	lt.markFailed(t0.Add(16*time.Minute + 5*time.Second))
	if ok, _ := lt.record(true, false, 3, t0.Add(16*time.Minute+25*time.Second)); ok {
		t.Fatalf("expected 30s retry backoff to suppress at +20s")
	}
	if ok, _ := lt.record(true, false, 3, t0.Add(16*time.Minute+37*time.Second)); !ok {
		t.Fatalf("expected Auto MTR retry allowed after 30s failure backoff")
	}
}

func TestLossTrackerHighLatencyAndRecoveryRearm(t *testing.T) {
	t.Parallel()

	t0 := time.Unix(1_700_000_000, 0)
	var lt lossTracker

	// 3 consecutive high-latency samples (with 0% loss) trigger auto_latency
	if ok, _ := lt.record(false, true, 3, t0); ok {
		t.Fatalf("1st high latency sample should not trigger")
	}
	if ok, _ := lt.record(false, true, 3, t0.Add(time.Second)); ok {
		t.Fatalf("2nd high latency sample should not trigger")
	}
	ok, reason := lt.record(false, true, 3, t0.Add(2*time.Second))
	if !ok || reason != "auto_latency" {
		t.Fatalf("expected 3rd high latency sample to trigger auto_latency, got ok=%v reason=%q", ok, reason)
	}

	// Recover with 5 consecutive healthy samples, then after 2m re-arm cooldown a new spike triggers again
	for i := 1; i <= 15; i++ {
		lt.record(false, false, 3, t0.Add(time.Duration(2+i)*time.Second))
	}

	tNext := t0.Add(3 * time.Minute)
	lt.record(false, true, 3, tNext)
	lt.record(false, true, 3, tNext.Add(time.Second))
	ok2, reason2 := lt.record(false, true, 3, tNext.Add(2*time.Second))
	if !ok2 || reason2 != "auto_latency" {
		t.Fatalf("expected recovered target to re-arm and trigger auto_latency on new incident, got ok=%v reason=%q", ok2, reason2)
	}
}
