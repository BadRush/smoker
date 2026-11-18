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
	mtrRollingWindowSize  = 15
	autoMTRRepeatInterval = 15 * time.Minute
	autoMTRRearmCooldown  = 2 * time.Minute
	autoMTRRetryBackoff   = 30 * time.Second
	autoMTRRecoverSamples = 5
)

type SampleHandler func(protocol.SampleRecord)
type AutoMTRHandler func(targetID, host, probeType, reason string) error

type lossTracker struct {
	mu                  sync.Mutex
	consecutiveImpaired int
	consecutiveHealthy  int
	ring                [mtrRollingWindowSize]bool
	lossRing            [mtrRollingWindowSize]bool
	ringPos             int
	ringCount           int
	windowImpaired      int
	windowLosses        int
	inIncident          bool
	lastAutoMTR         time.Time
}

func (l *lossTracker) record(isLoss, isHighLatency bool, threshold int, now time.Time) (bool, string) {
	l.mu.Lock()
	defer l.mu.Unlock()

	isImpaired := isLoss || isHighLatency

	if l.ringCount == mtrRollingWindowSize {
		if l.ring[l.ringPos] {
			l.windowImpaired--
		}
		if l.lossRing[l.ringPos] {
			l.windowLosses--
		}
	} else {
		l.ringCount++
	}
	l.ring[l.ringPos] = isImpaired
	l.lossRing[l.ringPos] = isLoss
	l.ringPos = (l.ringPos + 1) % mtrRollingWindowSize
	if isLoss {
		l.windowLosses++
	}

	if isImpaired {
		l.windowImpaired++
		l.consecutiveImpaired++
		l.consecutiveHealthy = 0
	} else {
		l.consecutiveImpaired = 0
		l.consecutiveHealthy++
		if l.inIncident && l.consecutiveHealthy >= autoMTRRecoverSamples {
			l.inIncident = false
		}
		return false, ""
	}

	effThresh := threshold
	if effThresh < 1 {
		effThresh = 1
	}

	if l.consecutiveImpaired < effThresh && l.windowImpaired < effThresh {
		return false, ""
	}

	if l.inIncident {
		// Edge-triggered anti-spam: while continuously impaired, only re-capture at most once every 15m
		if !l.lastAutoMTR.IsZero() && now.Sub(l.lastAutoMTR) < autoMTRRepeatInterval {
			return false, ""
		}
	} else {
		// Minimum cooldown between distinct flapping incidents
		if !l.lastAutoMTR.IsZero() && now.Sub(l.lastAutoMTR) < autoMTRRearmCooldown {
			return false, ""
		}
		l.inIncident = true
	}

	l.lastAutoMTR = now
	reason := "auto_latency"
	if isLoss || l.windowLosses > 0 {
		reason = "auto_loss"
	}
	return true, reason
}

// markFailed shortens cooldown on transient MTR error so next retry happens after 30s instead of 15m.
func (l *lossTracker) markFailed(now time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.inIncident = false
	l.lastAutoMTR = now.Add(-(autoMTRRearmCooldown - autoMTRRetryBackoff))
}

func computeDynamicWarnMs(baselineMs float64, explicitWarnMs int) float64 {
	if explicitWarnMs > 0 {
		return float64(explicitWarnMs)
	}
	if baselineMs <= 0 {
		return 0
	}
	var factor, minDelta float64
	if baselineMs < 10 {
		factor = 2.5
		minDelta = 12
	} else if baselineMs < 60 {
		factor = 1.85
		minDelta = 22
	} else {
		factor = 1.55
		minDelta = 40
	}
	scaled := baselineMs * factor
	shifted := baselineMs + minDelta
	if scaled > shifted {
		return math.Round(scaled)
	}
	return math.Round(shifted)
}

type targetWorker struct {
	cfg    protocol.TargetConfig
	ctx    context.Context
	cancel context.CancelFunc
}

type Scheduler struct {
	icmp      *ICMPProber
	opts      ProberOptions
	clk       *clock.Tracker
	onSample  SampleHandler
	onAutoMTR AutoMTRHandler

	mu      sync.Mutex
	workers map[string]targetWorker
}

func NewScheduler(icmpProber *ICMPProber, clk *clock.Tracker, onSample SampleHandler, onAutoMTR AutoMTRHandler) *Scheduler {
	return NewSchedulerWithOptions(icmpProber, ProberOptions{}, clk, onSample, onAutoMTR)
}

func NewSchedulerWithOptions(icmpProber *ICMPProber, opts ProberOptions, clk *clock.Tracker, onSample SampleHandler, onAutoMTR AutoMTRHandler) *Scheduler {
	return &Scheduler{
		icmp:      icmpProber,
		opts:      opts,
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
	var healthyCount int
	var baselineMs float64
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
			rtt, err = ProbeTCPWithOptions(probeCtx, "tcp", t.Host, t.PortOrPath, timeout, s.opts)
		case "tcp6":
			rtt, err = ProbeTCPWithOptions(probeCtx, "tcp6", t.Host, t.PortOrPath, timeout, s.opts)
		case "http":
			rtt, err = ProbeHTTPWithOptions(probeCtx, "tcp", t.Host, t.PortOrPath, timeout, s.opts)
		case "http6":
			rtt, err = ProbeHTTPWithOptions(probeCtx, "tcp6", t.Host, t.PortOrPath, timeout, s.opts)
		case "dns":
			rtt, err = ProbeDNSWithOptions(probeCtx, false, t.Host, t.PortOrPath, timeout, s.opts)
		case "dns6":
			rtt, err = ProbeDNSWithOptions(probeCtx, true, t.Host, t.PortOrPath, timeout, s.opts)
		default:
			return
		}

		tsNs := s.clk.AdjustedNowUnixNs()
		rec := protocol.SampleRecord{
			TimestampNs: tsNs,
			TargetID:    t.ID,
		}

		now := time.Now()
		if err != nil {
			rec.IsLoss = true
			hasPrevRTT = false
			if t.AutoMTROnLoss && s.onAutoMTR != nil {
				if shouldRun, reason := tracker.record(true, false, t.MTRLossThreshold, now); shouldRun {
					go func(targetID, host, probeType, trigReason string) {
						if mtrErr := s.onAutoMTR(targetID, host, probeType, trigReason); mtrErr != nil {
							tracker.markFailed(time.Now())
						}
					}(t.ID, t.Host, t.ProbeType, reason)
				}
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

			rttMs := float64(rttUs) / 1000.0
			healthyCount++
			if baselineMs <= 0 || healthyCount == 1 {
				baselineMs = rttMs
			} else if rttMs < baselineMs {
				baselineMs = baselineMs*0.65 + rttMs*0.35
			} else if healthyCount <= 5 {
				baselineMs = baselineMs*0.8 + rttMs*0.2
			}

			effBaseline := 0.0
			if healthyCount >= 5 {
				effBaseline = baselineMs
			}
			warnMs := computeDynamicWarnMs(effBaseline, t.LatencyWarnMs)
			isHighLat := warnMs > 0 && rttMs >= warnMs
			if !isHighLat && healthyCount > 5 && rttMs > baselineMs {
				baselineMs = baselineMs*0.98 + rttMs*0.02
			}

			if shouldRun, reason := tracker.record(false, isHighLat, t.MTRLossThreshold, now); shouldRun && t.AutoMTROnLoss && s.onAutoMTR != nil {
				go func(targetID, host, probeType, trigReason string) {
					if mtrErr := s.onAutoMTR(targetID, host, probeType, trigReason); mtrErr != nil {
						tracker.markFailed(time.Now())
					}
				}(t.ID, t.Host, t.ProbeType, reason)
			}
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
