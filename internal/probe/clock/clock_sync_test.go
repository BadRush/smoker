package clock

import (
	"math"
	"testing"
)

func TestTrackerRejectsHighRTTSpike(t *testing.T) {
	t.Parallel()
	tr := NewTracker()

	// True offset is +200ms (200_000_000 ns) with 4ms symmetric control RTT
	trueOff := int64(200_000_000)
	for i := 0; i < 3; i++ {
		t1 := int64(1_000_000_000)
		t2 := t1 + trueOff + 2_000_000
		t3 := t2 + 500_000
		t4 := t1 + 4_500_000
		tr.Record(t1, t2, t3, t4)
	}

	// Asymmetric spike with huge RTT (500ms) should be ignored by lowest-3 RTT median filter
	t1 := int64(2_000_000_000)
	t2 := t1 + trueOff + 490_000_000
	t3 := t2 + 1_000_000
	t4 := t1 + 501_000_000
	got := tr.Record(t1, t2, t3, t4)

	if math.Abs(got-200.0) > 1.0 {
		t.Fatalf("OffsetMs() = %.3f, want ~200.0", got)
	}
}
