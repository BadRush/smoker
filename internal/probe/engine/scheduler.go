package engine

import (
	"context"
	"log/slog"
	"math"
	"sync"
	"time"

	"smoker/internal/probe/clock"
	"smoker/internal/protocol"
)

const (
	mtrRollingWindowSize = 15
	autoMTRCooldown      = 2 * time.Minute
	autoMTRRetryBackoff  = 30 * time.Second
)

type SampleHandler func(protocol.SampleRecord)
type AutoMTRHandler func(targetID, host, probeType string) error

type lossTracker struct {
	mu              sync.Mutex
	consecutiveLoss int
	ring            [mtrRollingWindowSize]bool
	ringPos         int
	ringCount       int
	windowLosses    int
	lastAutoMTR     time.Time
}

func (l *lossTracker) record(isLoss bool, threshold int, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	if l.ringCount == mtrRollingWindowSize {
		if l.ring[l.ringPos] {
			l.windowLosses--
		}
	} else {
		l.ringCount++
	}
	l.ring[l.ringPos] = isLoss
	l.ringPos = (l.ringPos + 1) % mtrRollingWindowSize
	if isLoss {
		l.windowLosses++
		l.consecutiveLoss++
	} else {
		l.consecutiveLoss = 0
		return false
	}

	effThresh := threshold
	if effThresh < 1 {
		effThresh = 1
	}

	if l.consecutiveLoss < effThresh && l.windowLosses < effThresh {
		return false
	}
	if !l.lastAutoMTR.IsZero() && now.Sub(l.lastAutoMTR) <= autoMTRCooldown {
		return false
	}
	l.lastAutoMTR = now
	return true
}

// markFailed shortens cooldown on transient MTR error so next retry happens after 30s instead of 2m.
func (l *lossTracker) markFailed(now time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lastAutoMTR = now.Add(-(autoMTRCooldown - autoMTRRetryBackoff))
}

type targetWorker struct {
	cfg    protocol.TargetConfig
	ctx    context.Context
	cancel context.CancelFunc
}

type Scheduler struct {
	icmp      *ICMPProber
	clk       *clock.Tracker
	onSample  SampleHandler
	onAutoMTR AutoMTRHandler

	mu      sync.Mutex
	workers map[string]targetWorker
}

func NewScheduler(icmpProber *ICMPProber, clk *clock.Tracker, onSample SampleHandler, onAutoMTR AutoMTRHandler) *Scheduler {
	return &Scheduler{
		icmp:      icmpProber,
		clk:       clk,
		onSample:  onSample,
		onAutoMTR: onAutoMTR,
		workers:   make(map[string]targetWorker),
	}
}

func (s *Scheduler) ApplyConfig(parentCtx context.Context, targets []protocol.TargetConfig) {
	s.mu.Lock()
	defer s.mu.Unlock()

	wanted := make(map[string]protocol.TargetConfig, len(targets))
	for _, t := range targets {
		wanted[t.ID] = t
	}

	// Stop removed, changed, or terminated targets
	for id, w := range s.workers {
		next, ok := wanted[id]
		if !ok || next != w.cfg || (w.ctx != nil && w.ctx.Err() != nil) {
			w.cancel()
			delete(s.workers, id)
		}
	}

	// Start new or updated targets
	for id, t := range wanted {
		if _, exists := s.workers[id]; exists {
			continue
		}
		ctx, cancel := context.WithCancel(parentCtx)
		s.workers[id] = targetWorker{cfg: t, ctx: ctx, cancel: cancel}
		go s.runTargetLoop(ctx, t)
	}
}

func (s *Scheduler) StopAll() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, w := range s.workers {
		w.cancel()
		delete(s.workers, id)
	}
}

func (s *Scheduler) runTargetLoop(ctx context.Context, t protocol.TargetConfig) {
	interval := time.Duration(t.IntervalSec) * time.Second
	if interval < time.Second {
		interval = time.Second
	}
	timeout := time.Duration(t.TimeoutMs) * time.Millisecond
	if timeout < 100*time.Millisecond {
		timeout = time.Second
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	var hasPrevRTT bool
	var prevRTTUs int32
	var tracker lossTracker

	execute := func() {
		probeCtx, cancel := context.WithTimeout(ctx, timeout+200*time.Millisecond)
		defer cancel()

		var rtt time.Duration
		var err error
		switch t.ProbeType {
		case "icmp":
			rtt, err = s.icmp.Ping(probeCtx, t.Host, timeout)
		case "icmp6":
			rtt, err = s.icmp.PingIPv6(probeCtx, t.Host, timeout)
		case "tcp":
			rtt, err = ProbeTCP(probeCtx, t.Host, t.PortOrPath, timeout)
		case "tcp6":
			rtt, err = ProbeTCPWithNetwork(probeCtx, "tcp6", t.Host, t.PortOrPath, timeout)
		case "http":
			rtt, err = ProbeHTTP(probeCtx, t.Host, t.PortOrPath, timeout)
		case "http6":
			rtt, err = ProbeHTTPWithNetwork(probeCtx, "tcp6", t.Host, t.PortOrPath, timeout)
		case "dns":
			rtt, err = ProbeDNS(probeCtx, t.Host, t.PortOrPath, timeout)
		case "dns6":
			rtt, err = ProbeDNSWithFamily(probeCtx, true, t.Host, t.PortOrPath, timeout)
		default:
			return
		}

		tsNs := s.clk.AdjustedNowUnixNs()
		rec := protocol.SampleRecord{
			TimestampNs: tsNs,
			TargetID:    t.ID,
		}

		if err != nil {
			rec.IsLoss = true
			hasPrevRTT = false
			if t.AutoMTROnLoss && tracker.record(true, t.MTRLossThreshold, time.Now()) && s.onAutoMTR != nil {
				go func(targetID, host, probeType string) {
					if mtrErr := s.onAutoMTR(targetID, host, probeType); mtrErr != nil {
						tracker.markFailed(time.Now())
					}
				}(t.ID, t.Host, t.ProbeType)
			}
		} else {
			rttUs := int32(rtt.Microseconds())
			if rttUs < 1 {
				rttUs = 1
			}
			rec.RTTUs = &rttUs
			if hasPrevRTT {
				rec.JitterUs = int32(math.Abs(float64(rttUs - prevRTTUs)))
			}
			prevRTTUs = rttUs
			hasPrevRTT = true
			tracker.record(false, t.MTRLossThreshold, time.Now())
		}

		s.onSample(rec)
	}

	// Run immediately on start, then on interval ticks
	execute()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			execute()
		}
	}
}

func init() {
	_ = slog.Default()
}
