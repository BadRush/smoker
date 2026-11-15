package clock

import (
	"sort"
	"sync"
	"time"
)

type sample struct {
	offsetNs int64
	rttNs    int64
}

// Tracker implements NTP-style 4-timestamp clock offset estimation with lowest-RTT median filtering.
type Tracker struct {
	mu       sync.RWMutex
	history  []sample
	offsetNs int64
}

func NewTracker() *Tracker {
	return &Tracker{
		history: make([]sample, 0, 7),
	}
}

func (t *Tracker) Record(t1Ns, t2Ns, t3Ns, t4Ns int64) float64 {
	rttNs := (t4Ns - t1Ns) - (t3Ns - t2Ns)
	if rttNs < 0 {
		rttNs = 0
	}
	offsetNs := ((t2Ns - t1Ns) + (t3Ns - t4Ns)) / 2

	t.mu.Lock()
	defer t.mu.Unlock()

	t.history = append(t.history, sample{offsetNs: offsetNs, rttNs: rttNs})
	if len(t.history) > 7 {
		t.history = append([]sample(nil), t.history[len(t.history)-7:]...)
	}

	// Pick up to 3 samples with lowest control RTT and take their median offset
	sortedByRTT := append([]sample(nil), t.history...)
	sort.Slice(sortedByRTT, func(i, j int) bool { return sortedByRTT[i].rttNs < sortedByRTT[j].rttNs })
	k := 3
	if len(sortedByRTT) < k {
		k = len(sortedByRTT)
	}
	best := sortedByRTT[:k]
	sort.Slice(best, func(i, j int) bool { return best[i].offsetNs < best[j].offsetNs })
	t.offsetNs = best[len(best)/2].offsetNs

	return float64(t.offsetNs) / 1e6
}

func (t *Tracker) OffsetMs() float64 {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return float64(t.offsetNs) / 1e6
}

func (t *Tracker) AdjustedNowUnixNs() int64 {
	t.mu.RLock()
	off := t.offsetNs
	t.mu.RUnlock()
	return time.Now().UTC().UnixNano() + off
}
