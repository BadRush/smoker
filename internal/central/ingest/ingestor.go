package ingest

import (
	"context"
	"fmt"
	"math"
	"sort"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"smoker/internal/central/db"
	"smoker/internal/protocol"
)

type SparkPoint struct {
	TS   int64    `json:"ts"`
	Min  *float64 `json:"min"`
	P50  *float64 `json:"p50"`
	P95  *float64 `json:"p95"`
	Loss float64  `json:"loss"`
}

type MatrixCell struct {
	TargetID    uuid.UUID    `json:"target_id"`
	ProbeID     uuid.UUID    `json:"probe_id"`
	P50Ms       *float64     `json:"p50_ms"`
	P95Ms       *float64     `json:"p95_ms"`
	BaselineMs  *float64     `json:"baseline_ms"`
	WarnMs      *float64     `json:"warn_ms"`
	JitterMs    float64      `json:"jitter_ms"`
	LossPct     float64      `json:"loss_pct"`
	SampleCount int          `json:"sample_count"`
	LastSeenAt  *time.Time   `json:"last_seen_at"`
	Status      string       `json:"status"`
	Sparkline   []SparkPoint `json:"sparkline"`
}

type WindowStats struct {
	SampleCount      int
	LossCount        int
	LossPct          float64
	P95Ms            float64
	BaselineMs       float64
	BaselineSpikePct float64
	AvgJitterMs      float64
}

type cachedSample struct {
	ts       time.Time
	rttUs    int32
	jitterUs int32
	isLoss   bool
}

type seriesKey struct {
	targetID uuid.UUID
	probeID  uuid.UUID
}

type simOverride struct {
	mode  string
	until time.Time
}

type RollingCache struct {
	mu          sync.RWMutex
	entries     map[seriesKey][]cachedSample
	simulations map[seriesKey]simOverride
	maxAge      time.Duration
}

func NewRollingCache(maxAge time.Duration) *RollingCache {
	if maxAge <= 0 {
		maxAge = 10 * time.Minute
	}
	return &RollingCache{
		entries:     make(map[seriesKey][]cachedSample),
		simulations: make(map[seriesKey]simOverride),
		maxAge:      maxAge,
	}
}

// SimulateAnomaly sets or clears a temporary anomaly override (high_latency, intermittent_loss, down, clear) for testing TV Auto-Switch and Alerts.
func (c *RollingCache) SimulateAnomaly(targetID uuid.UUID, probeIDs []uuid.UUID, mode string, duration time.Duration, now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if mode == "clear" || duration <= 0 {
		for k := range c.simulations {
			if k.targetID == targetID {
				delete(c.simulations, k)
			}
		}
		return
	}

	until := now.Add(duration)
	if len(probeIDs) == 0 {
		for k := range c.entries {
			if k.targetID == targetID {
				c.simulations[k] = simOverride{mode: mode, until: until}
			}
		}
		return
	}
	for _, pid := range probeIDs {
		k := seriesKey{targetID: targetID, probeID: pid}
		c.simulations[k] = simOverride{mode: mode, until: until}
	}
}

func (c *RollingCache) Add(probeID, targetID uuid.UUID, ts time.Time, rttUs *int32, jitterUs int32, isLoss bool, now time.Time) {
	if ts.Before(now.Add(-c.maxAge)) {
		return
	}
	var rtt int32
	if rttUs != nil {
		rtt = *rttUs
	}

	k := seriesKey{targetID: targetID, probeID: probeID}
	c.mu.Lock()
	defer c.mu.Unlock()

	buf := append(c.entries[k], cachedSample{ts: ts, rttUs: rtt, jitterUs: jitterUs, isLoss: isLoss})
	cutoff := now.Add(-c.maxAge)
	trimIdx := 0
	for trimIdx < len(buf) && buf[trimIdx].ts.Before(cutoff) {
		trimIdx++
	}
	if trimIdx > 0 {
		buf = append([]cachedSample(nil), buf[trimIdx:]...)
	}
	if len(buf) > 900 {
		buf = append([]cachedSample(nil), buf[len(buf)-900:]...)
	}
	c.entries[k] = buf
}

func (c *RollingCache) WindowStats(targetID, probeID uuid.UUID, window time.Duration, now time.Time) WindowStats {
	k := seriesKey{targetID: targetID, probeID: probeID}
	c.mu.RLock()
	buf := c.entries[k]
	sim, hasSim := c.simulations[k]
	if len(buf) == 0 && (!hasSim || !now.Before(sim.until)) {
		c.mu.RUnlock()
		return WindowStats{}
	}
	cutoff := now.Add(-window)
	var rtts, allHealthy []int32
	var totalJitter int64
	var okCount, lossCount, totalCount int
	for _, s := range buf {
		if !s.isLoss {
			allHealthy = append(allHealthy, s.rttUs)
		}
		if s.ts.Before(cutoff) {
			continue
		}
		totalCount++
		if s.isLoss {
			lossCount++
		} else {
			okCount++
			rtts = append(rtts, s.rttUs)
			totalJitter += int64(s.jitterUs)
		}
	}
	c.mu.RUnlock()

	var baselineMs float64
	if len(allHealthy) > 0 {
		sort.Slice(allHealthy, func(i, j int) bool { return allHealthy[i] < allHealthy[j] })
		baselineMs = round2(float64(percentileSorted(allHealthy, 0.25)) / 1000.0)
	}

	if hasSim && now.Before(sim.until) {
		base := baselineMs
		if base <= 0 {
			base = 10.0
		}
		switch sim.mode {
		case "down":
			return WindowStats{
				SampleCount: 15,
				LossCount:   15,
				LossPct:     100.0,
				BaselineMs:  baselineMs,
			}
		case "intermittent_loss":
			p95 := round2(base*1.8 + 12.0)
			return WindowStats{
				SampleCount:      15,
				LossCount:        5,
				LossPct:          33.33,
				P95Ms:            p95,
				BaselineMs:       base,
				BaselineSpikePct: round2(((p95 - base) / base) * 100.0),
				AvgJitterMs:      18.5,
			}
		case "high_latency":
			p95 := round2(math.Max(base*3.2, base+65.0))
			return WindowStats{
				SampleCount:      15,
				LossCount:        0,
				LossPct:          0,
				P95Ms:            p95,
				BaselineMs:       base,
				BaselineSpikePct: round2(((p95 - base) / base) * 100.0),
				AvgJitterMs:      14.0,
			}
		}
	}

	if totalCount == 0 {
		return WindowStats{}
	}
	stats := WindowStats{
		SampleCount: totalCount,
		LossCount:   lossCount,
		LossPct:     (float64(lossCount) * 100.0) / float64(totalCount),
		BaselineMs:  baselineMs,
	}
	if okCount > 0 {
		sort.Slice(rtts, func(i, j int) bool { return rtts[i] < rtts[j] })
		stats.P95Ms = float64(percentileSorted(rtts, 0.95)) / 1000.0
		stats.AvgJitterMs = (float64(totalJitter) / float64(okCount)) / 1000.0
		if baselineMs > 0 && (stats.P95Ms-baselineMs) >= 15.0 {
			stats.BaselineSpikePct = round2(((stats.P95Ms - baselineMs) / baselineMs) * 100.0)
		}
	}
	return stats
}

func (c *RollingCache) BuildMatrixCells(targets []db.Target, probes []db.Probe, now time.Time) []MatrixCell {
	cutoff := now.Add(-60 * time.Second)
	c.mu.RLock()
	defer c.mu.RUnlock()

	cells := make([]MatrixCell, 0, len(targets)*len(probes))
	for _, t := range targets {
		assigned := make(map[uuid.UUID]bool, len(t.ProbeIDs))
		for _, pid := range t.ProbeIDs {
			assigned[pid] = true
		}
		for _, p := range probes {
			if !t.AssignAllProbes && !assigned[p.ID] {
				continue
			}
			cell := MatrixCell{
				TargetID:  t.ID,
				ProbeID:   p.ID,
				Status:    "unknown",
				Sparkline: make([]SparkPoint, 0),
			}
			key := seriesKey{targetID: t.ID, probeID: p.ID}
			buf := c.entries[key]
			cell.Sparkline = buildSparkline(buf, now)

			// 1. Compute full-buffer best-path baseline (P25 of healthy samples in 10m window)
			var allRtts []int32
			for _, s := range buf {
				if !s.isLoss && s.rttUs > 0 {
					allRtts = append(allRtts, s.rttUs)
				}
			}
			if len(allRtts) > 0 {
				sort.Slice(allRtts, func(i, j int) bool { return allRtts[i] < allRtts[j] })
				baseVal := round2(float64(percentileSorted(allRtts, 0.25)) / 1000.0)
				cell.BaselineMs = &baseVal
			}

			// 2. Resolve effective warn threshold for this (Target, Probe) pair
			var warnVal float64
			if t.ProbeLatencyOverrides != nil {
				if ov, ok := t.ProbeLatencyOverrides[p.ID.String()]; ok && ov > 0 {
					warnVal = float64(ov)
				}
			}
			if warnVal <= 0 && t.LatencyWarnMs > 0 {
				warnVal = float64(t.LatencyWarnMs)
			}
			if warnVal <= 0 && cell.BaselineMs != nil && *cell.BaselineMs > 0 {
				warnVal = round2(math.Max(*cell.BaselineMs*2.0, *cell.BaselineMs+15.0))
			}
			if warnVal <= 0 {
				timeout := t.TimeoutMs
				if timeout <= 0 {
					timeout = 1000
				}
				warnVal = round2(float64(timeout) * 0.5)
			}
			cell.WarnMs = &warnVal

			// 3. Check active simulation override
			if sim, hasSim := c.simulations[key]; hasSim && now.Before(sim.until) {
				tsCopy := now
				cell.LastSeenAt = &tsCopy
				cell.SampleCount = 15
				base := 8.0
				if cell.BaselineMs != nil && *cell.BaselineMs > 0 {
					base = *cell.BaselineMs
				} else {
					bCopy := base
					cell.BaselineMs = &bCopy
				}
				switch sim.mode {
				case "down":
					cell.LossPct = 100.0
					cell.Status = "down"
					cell.Sparkline = append(cell.Sparkline, SparkPoint{TS: now.Unix(), Loss: 100})
				case "intermittent_loss":
					p50 := round2(base * 1.4)
					p95 := round2(base*1.8 + 12.0)
					cell.P50Ms = &p50
					cell.P95Ms = &p95
					cell.JitterMs = 18.5
					cell.LossPct = 33.33
					cell.Status = "loss"
					cell.Sparkline = append(cell.Sparkline, SparkPoint{TS: now.Unix(), P50: &p50, P95: &p95, Loss: 33.33})
				case "high_latency":
					p50 := round2(math.Max(warnVal*1.35, base+45.0))
					p95 := round2(math.Max(warnVal*1.65, base+65.0))
					cell.P50Ms = &p50
					cell.P95Ms = &p95
					cell.JitterMs = 14.2
					cell.LossPct = 0
					cell.Status = "degraded"
					cell.Sparkline = append(cell.Sparkline, SparkPoint{TS: now.Unix(), P50: &p50, P95: &p95, Loss: 0})
				}
				cells = append(cells, cell)
				continue
			}

			var rtts []int32
			var sumJitter int64
			var okCnt, lossCnt int
			var lastTs time.Time

			for _, s := range buf {
				if s.ts.Before(cutoff) {
					continue
				}
				cell.SampleCount++
				if s.ts.After(lastTs) {
					lastTs = s.ts
				}
				if s.isLoss {
					lossCnt++
				} else {
					okCnt++
					rtts = append(rtts, s.rttUs)
					sumJitter += int64(s.jitterUs)
				}
			}

			if cell.SampleCount > 0 {
				tsCopy := lastTs
				cell.LastSeenAt = &tsCopy
				cell.LossPct = math.Round(((float64(lossCnt)*100.0)/float64(cell.SampleCount))*100) / 100
				if okCnt > 0 {
					sort.Slice(rtts, func(i, j int) bool { return rtts[i] < rtts[j] })
					p50 := math.Round((float64(percentileSorted(rtts, 0.50))/1000.0)*100) / 100
					p95 := math.Round((float64(percentileSorted(rtts, 0.95))/1000.0)*100) / 100
					cell.P50Ms = &p50
					cell.P95Ms = &p95
					cell.JitterMs = math.Round(((float64(sumJitter)/float64(okCnt))/1000.0)*100) / 100
				}

				switch {
				case lossCnt == cell.SampleCount || cell.LossPct >= 50:
					cell.Status = "down"
				case cell.LossPct > 0:
					cell.Status = "loss"
				case cell.P50Ms != nil && cell.WarnMs != nil && (*cell.P50Ms >= *cell.WarnMs || (cell.P95Ms != nil && *cell.P95Ms >= *cell.WarnMs*1.25)):
					cell.Status = "degraded"
				default:
					cell.Status = "healthy"
				}
			}
			cells = append(cells, cell)
		}
	}
	return cells
}

func buildSparkline(buf []cachedSample, now time.Time) []SparkPoint {
	const maxPoints = 36
	cutoff := now.Add(-5 * time.Minute)
	recent := make([]cachedSample, 0, len(buf))
	for _, s := range buf {
		if !s.ts.Before(cutoff) {
			recent = append(recent, s)
		}
	}
	if len(recent) == 0 {
		return []SparkPoint{}
	}
	if len(recent) <= maxPoints {
		out := make([]SparkPoint, 0, len(recent))
		for _, s := range recent {
			pt := SparkPoint{TS: s.ts.Unix()}
			if s.isLoss {
				pt.Loss = 100
			} else {
				v := round2(float64(s.rttUs) / 1000.0)
				pt.Min = &v
				pt.P50 = &v
				pt.P95 = &v
			}
			out = append(out, pt)
		}
		return out
	}

	out := make([]SparkPoint, 0, maxPoints)
	n := len(recent)
	for b := 0; b < maxPoints; b++ {
		start := (b * n) / maxPoints
		end := ((b + 1) * n) / maxPoints
		if end <= start {
			continue
		}
		slice := recent[start:end]
		pt := SparkPoint{TS: slice[len(slice)-1].ts.Unix()}
		rtts := make([]int32, 0, len(slice))
		var losses int
		for _, s := range slice {
			if s.isLoss {
				losses++
			} else {
				rtts = append(rtts, s.rttUs)
			}
		}
		pt.Loss = round2((float64(losses) * 100.0) / float64(len(slice)))
		if len(rtts) > 0 {
			sort.Slice(rtts, func(i, j int) bool { return rtts[i] < rtts[j] })
			vMin := round2(float64(rtts[0]) / 1000.0)
			vP50 := round2(float64(percentileSorted(rtts, 0.50)) / 1000.0)
			vP95 := round2(float64(percentileSorted(rtts, 0.95)) / 1000.0)
			pt.Min = &vMin
			pt.P50 = &vP50
			pt.P95 = &vP95
		}
		out = append(out, pt)
	}
	return out
}

func round2(v float64) float64 {
	return math.Round(v*100) / 100
}

func percentileSorted(sorted []int32, p float64) int32 {
	if len(sorted) == 0 {
		return 0
	}
	if len(sorted) == 1 {
		return sorted[0]
	}
	idx := int(math.Ceil(p*float64(len(sorted)))) - 1
	if idx < 0 {
		idx = 0
	}
	if idx >= len(sorted) {
		idx = len(sorted) - 1
	}
	return sorted[idx]
}

type Ingestor struct {
	pool  *pgxpool.Pool
	cache *RollingCache
}

func NewIngestor(pool *pgxpool.Pool, cache *RollingCache) *Ingestor {
	return &Ingestor{pool: pool, cache: cache}
}

type parsedRow struct {
	ts       time.Time
	probeID  uuid.UUID
	targetID uuid.UUID
	rttUs    *int32
	jitterUs int32
	isLoss   bool
}

func (in *Ingestor) IngestBatch(ctx context.Context, probeID uuid.UUID, isBackfill bool, records []protocol.SampleRecord) (int, error) {
	if len(records) == 0 {
		return 0, nil
	}

	rows := make([]parsedRow, 0, len(records))
	now := time.Now().UTC()

	for _, r := range records {
		tid, err := uuid.Parse(r.TargetID)
		if err != nil {
			continue
		}
		ts := time.Unix(0, r.TimestampNs).UTC()
		rows = append(rows, parsedRow{
			ts:       ts,
			probeID:  probeID,
			targetID: tid,
			rttUs:    r.RTTUs,
			jitterUs: r.JitterUs,
			isLoss:   r.IsLoss,
		})
	}
	if len(rows) == 0 {
		return 0, nil
	}

	if !isBackfill && len(rows) <= 500 {
		if err := in.upsertUnnest(ctx, rows); err != nil {
			return 0, err
		}
	} else {
		if err := in.upsertCopyTemp(ctx, rows); err != nil {
			return 0, err
		}
	}

	for _, r := range rows {
		in.cache.Add(r.probeID, r.targetID, r.ts, r.rttUs, r.jitterUs, r.isLoss, now)
	}
	return len(rows), nil
}

func (in *Ingestor) upsertUnnest(ctx context.Context, rows []parsedRow) error {
	times := make([]time.Time, len(rows))
	probeIDs := make([]uuid.UUID, len(rows))
	targetIDs := make([]uuid.UUID, len(rows))
	rtts := make([]*int32, len(rows))
	jitters := make([]int32, len(rows))
	losses := make([]bool, len(rows))

	for i, r := range rows {
		times[i] = r.ts
		probeIDs[i] = r.probeID
		targetIDs[i] = r.targetID
		rtts[i] = r.rttUs
		jitters[i] = r.jitterUs
		losses[i] = r.isLoss
	}

	_, err := in.pool.Exec(ctx, `
		INSERT INTO ping_samples (time, probe_id, target_id, rtt_us, jitter_us, is_loss)
		SELECT * FROM unnest($1::timestamptz[], $2::uuid[], $3::uuid[], $4::int4[], $5::int4[], $6::bool[])
		ON CONFLICT (target_id, probe_id, time) DO NOTHING
	`, times, probeIDs, targetIDs, rtts, jitters, losses)
	if err != nil {
		return fmt.Errorf("unnest upsert ping_samples: %w", err)
	}
	return nil
}

func (in *Ingestor) upsertCopyTemp(ctx context.Context, rows []parsedRow) error {
	tx, err := in.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `CREATE TEMP TABLE _stage_samples (LIKE ping_samples) ON COMMIT DROP`); err != nil {
		return fmt.Errorf("create temp stage: %w", err)
	}

	copySrc := pgx.CopyFromSlice(len(rows), func(i int) ([]any, error) {
		r := rows[i]
		return []any{r.ts, r.probeID, r.targetID, r.rttUs, r.jitterUs, r.isLoss}, nil
	})

	if _, err := tx.CopyFrom(ctx, pgx.Identifier{"_stage_samples"}, []string{"time", "probe_id", "target_id", "rtt_us", "jitter_us", "is_loss"}, copySrc); err != nil {
		return fmt.Errorf("copy into stage: %w", err)
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO ping_samples (time, probe_id, target_id, rtt_us, jitter_us, is_loss)
		SELECT time, probe_id, target_id, rtt_us, jitter_us, is_loss FROM _stage_samples
		ON CONFLICT (target_id, probe_id, time) DO NOTHING
	`); err != nil {
		return fmt.Errorf("merge stage into ping_samples: %w", err)
	}

	return tx.Commit(ctx)
}

func (in *Ingestor) WarmCache(ctx context.Context) error {
	now := time.Now().UTC()
	since := now.Add(-10 * time.Minute)
	rows, err := in.pool.Query(ctx, `
		SELECT time, probe_id, target_id, rtt_us, jitter_us, is_loss
		FROM ping_samples
		WHERE time >= $1
		ORDER BY time ASC
	`, since)
	if err != nil {
		return err
	}
	defer rows.Close()

	for rows.Next() {
		var ts time.Time
		var pid, tid uuid.UUID
		var rtt *int32
		var jitter int32
		var loss bool
		if err := rows.Scan(&ts, &pid, &tid, &rtt, &jitter, &loss); err != nil {
			return err
		}
		in.cache.Add(pid, tid, ts, rtt, jitter, loss, now)
	}
	return rows.Err()
}
