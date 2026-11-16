package db

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
)

type rangeSpec struct {
	window    time.Duration
	bucketSec int
	source    string // raw | agg_1m | agg_5m | agg_1h | agg_6h
}

func resolveRange(r string) rangeSpec {
	switch r {
	case "15m":
		return rangeSpec{window: 15 * time.Minute, bucketSec: 5, source: "raw"}
	case "1h":
		return rangeSpec{window: time.Hour, bucketSec: 15, source: "raw"}
	case "3h":
		return rangeSpec{window: 3 * time.Hour, bucketSec: 30, source: "raw"}
	case "6h":
		return rangeSpec{window: 6 * time.Hour, bucketSec: 60, source: "raw"}
	case "12h":
		return rangeSpec{window: 12 * time.Hour, bucketSec: 60, source: "agg_1m"}
	case "24h":
		return rangeSpec{window: 24 * time.Hour, bucketSec: 60, source: "agg_1m"}
	case "7d":
		return rangeSpec{window: 7 * 24 * time.Hour, bucketSec: 300, source: "agg_5m"}
	case "30d":
		return rangeSpec{window: 30 * 24 * time.Hour, bucketSec: 3600, source: "agg_1h"}
	case "1y":
		return rangeSpec{window: 365 * 24 * time.Hour, bucketSec: 21600, source: "agg_6h"}
	default: // "5m"
		return rangeSpec{window: 5 * time.Minute, bucketSec: 1, source: "raw"}
	}
}

func initTargetProbeSeries(target Target, probes []Probe) ([]*ProbeSeries, map[uuid.UUID]*ProbeSeries) {
	assignedSet := make(map[uuid.UUID]bool, len(target.ProbeIDs))
	for _, pid := range target.ProbeIDs {
		assignedSet[pid] = true
	}

	seriesMap := make(map[uuid.UUID]*ProbeSeries, len(probes))
	ordered := make([]*ProbeSeries, 0, len(probes))
	for _, p := range probes {
		if !target.AssignAllProbes && !assignedSet[p.ID] {
			continue
		}
		ps := &ProbeSeries{
			ProbeID:       p.ID,
			ProbeName:     p.Name,
			LocationLabel: p.LocationLabel,
			Timestamps:    make([]int64, 0),
			MinMs:         make([]*float64, 0),
			P25Ms:         make([]*float64, 0),
			P50Ms:         make([]*float64, 0),
			P75Ms:         make([]*float64, 0),
			P95Ms:         make([]*float64, 0),
			MaxMs:         make([]*float64, 0),
			JitterMs:      make([]*float64, 0),
			LossPct:       make([]float64, 0),
		}
		seriesMap[p.ID] = ps
		ordered = append(ordered, ps)
	}
	return ordered, seriesMap
}

func seriesSQLQuery(spec rangeSpec, batch bool) string {
	targetFilter := "target_id = $%d"
	if batch {
		targetFilter = "target_id = ANY($%d)"
	}

	switch spec.source {
	case "raw":
		where := fmt.Sprintf(targetFilter, 2) + " AND time >= $3"
		return fmt.Sprintf(`
			WITH buckets AS (
				SELECT
					target_id,
					time_bucket($1::interval, time) AS ts,
					probe_id,
					MIN(rtt_us) FILTER (WHERE NOT is_loss AND rtt_us IS NOT NULL) AS min_us,
					MAX(rtt_us) FILTER (WHERE NOT is_loss AND rtt_us IS NOT NULL) AS max_us,
					AVG(jitter_us) FILTER (WHERE NOT is_loss) AS avg_jitter_us,
					COUNT(*) AS sample_count,
					COUNT(*) FILTER (WHERE is_loss) AS loss_count,
					percentile_agg(rtt_us::DOUBLE PRECISION) FILTER (WHERE NOT is_loss AND rtt_us IS NOT NULL) AS pct
				FROM ping_samples
				WHERE %s
				GROUP BY target_id, ts, probe_id
			)
			SELECT
				target_id,
				probe_id,
				EXTRACT(EPOCH FROM ts)::BIGINT AS unix_sec,
				CASE WHEN min_us IS NOT NULL THEN min_us / 1000.0 END,
				CASE WHEN pct IS NOT NULL THEN approx_percentile(0.25, pct) / 1000.0 END,
				CASE WHEN pct IS NOT NULL THEN approx_percentile(0.50, pct) / 1000.0 END,
				CASE WHEN pct IS NOT NULL THEN approx_percentile(0.75, pct) / 1000.0 END,
				CASE WHEN pct IS NOT NULL THEN approx_percentile(0.95, pct) / 1000.0 END,
				CASE WHEN max_us IS NOT NULL THEN max_us / 1000.0 END,
				CASE WHEN avg_jitter_us IS NOT NULL THEN avg_jitter_us / 1000.0 END,
				CASE WHEN sample_count > 0 THEN (loss_count::DOUBLE PRECISION * 100.0) / sample_count ELSE 0 END
			FROM buckets
			ORDER BY target_id ASC, probe_id ASC, ts ASC
		`, where)
	case "agg_1m", "agg_5m":
		histWhere := fmt.Sprintf(targetFilter, 2) + " AND bucket >= $3"
		rawWhere := fmt.Sprintf(targetFilter, 2) + " AND time >= $4"
		return fmt.Sprintf(`
			WITH hist AS (
				SELECT
					target_id,
					probe_id,
					bucket AS ts,
					CASE WHEN min_us IS NOT NULL THEN min_us / 1000.0 END AS min_ms,
					CASE WHEN pct_agg IS NOT NULL THEN approx_percentile(0.25, pct_agg) / 1000.0 END AS p25_ms,
					CASE WHEN pct_agg IS NOT NULL THEN approx_percentile(0.50, pct_agg) / 1000.0 END AS p50_ms,
					CASE WHEN pct_agg IS NOT NULL THEN approx_percentile(0.75, pct_agg) / 1000.0 END AS p75_ms,
					CASE WHEN pct_agg IS NOT NULL THEN approx_percentile(0.95, pct_agg) / 1000.0 END AS p95_ms,
					CASE WHEN max_us IS NOT NULL THEN max_us / 1000.0 END AS max_ms,
					CASE WHEN (sample_count - loss_count) > 0 THEN (sum_jitter_us::DOUBLE PRECISION / (sample_count - loss_count)) / 1000.0 END AS jitter_ms,
					CASE WHEN sample_count > 0 THEN (loss_count::DOUBLE PRECISION * 100.0) / sample_count ELSE 0 END AS loss_pct
				FROM %s
				WHERE %s
			),
			raw_buckets AS (
				SELECT
					target_id,
					probe_id,
					time_bucket($1::interval, time) AS ts,
					MIN(rtt_us) FILTER (WHERE NOT is_loss AND rtt_us IS NOT NULL) AS min_us,
					MAX(rtt_us) FILTER (WHERE NOT is_loss AND rtt_us IS NOT NULL) AS max_us,
					AVG(jitter_us) FILTER (WHERE NOT is_loss) AS avg_jitter_us,
					COUNT(*) AS sample_count,
					COUNT(*) FILTER (WHERE is_loss) AS loss_count,
					percentile_agg(rtt_us::DOUBLE PRECISION) FILTER (WHERE NOT is_loss AND rtt_us IS NOT NULL) AS pct
				FROM ping_samples
				WHERE %s
				GROUP BY target_id, probe_id, ts
			),
			tail AS (
				SELECT
					r.target_id,
					r.probe_id,
					r.ts,
					CASE WHEN r.min_us IS NOT NULL THEN r.min_us / 1000.0 END AS min_ms,
					CASE WHEN r.pct IS NOT NULL THEN approx_percentile(0.25, r.pct) / 1000.0 END AS p25_ms,
					CASE WHEN r.pct IS NOT NULL THEN approx_percentile(0.50, r.pct) / 1000.0 END AS p50_ms,
					CASE WHEN r.pct IS NOT NULL THEN approx_percentile(0.75, r.pct) / 1000.0 END AS p75_ms,
					CASE WHEN r.pct IS NOT NULL THEN approx_percentile(0.95, r.pct) / 1000.0 END AS p95_ms,
					CASE WHEN r.max_us IS NOT NULL THEN r.max_us / 1000.0 END AS max_ms,
					CASE WHEN r.avg_jitter_us IS NOT NULL THEN r.avg_jitter_us / 1000.0 END AS jitter_ms,
					CASE WHEN r.sample_count > 0 THEN (r.loss_count::DOUBLE PRECISION * 100.0) / r.sample_count ELSE 0 END AS loss_pct
				FROM raw_buckets r
				WHERE NOT EXISTS (
					SELECT 1 FROM hist h
					WHERE h.target_id = r.target_id AND h.probe_id = r.probe_id AND h.ts = r.ts
				)
			),
			merged AS (
				SELECT * FROM hist
				UNION ALL
				SELECT * FROM tail
			)
			SELECT
				target_id,
				probe_id,
				EXTRACT(EPOCH FROM ts)::BIGINT AS unix_sec,
				min_ms, p25_ms, p50_ms, p75_ms, p95_ms, max_ms, jitter_ms, loss_pct
			FROM merged
			ORDER BY target_id ASC, probe_id ASC, ts ASC
		`, spec.source, histWhere, rawWhere)
	case "agg_1h":
		where := fmt.Sprintf(targetFilter, 1) + " AND bucket >= $2"
		return fmt.Sprintf(`
			SELECT
				target_id,
				probe_id,
				EXTRACT(EPOCH FROM bucket)::BIGINT AS unix_sec,
				CASE WHEN min_us IS NOT NULL THEN min_us / 1000.0 END,
				CASE WHEN pct_agg IS NOT NULL THEN approx_percentile(0.25, pct_agg) / 1000.0 END,
				CASE WHEN pct_agg IS NOT NULL THEN approx_percentile(0.50, pct_agg) / 1000.0 END,
				CASE WHEN pct_agg IS NOT NULL THEN approx_percentile(0.75, pct_agg) / 1000.0 END,
				CASE WHEN pct_agg IS NOT NULL THEN approx_percentile(0.95, pct_agg) / 1000.0 END,
				CASE WHEN max_us IS NOT NULL THEN max_us / 1000.0 END,
				CASE WHEN (sample_count - loss_count) > 0 THEN (sum_jitter_us::DOUBLE PRECISION / (sample_count - loss_count)) / 1000.0 END,
				CASE WHEN sample_count > 0 THEN (loss_count::DOUBLE PRECISION * 100.0) / sample_count ELSE 0 END
			FROM %s
			WHERE %s
			ORDER BY target_id ASC, probe_id ASC, bucket ASC
		`, spec.source, where)
	default: // "agg_6h"
		where := fmt.Sprintf(targetFilter, 2) + " AND bucket >= $3"
		return fmt.Sprintf(`
			WITH rolled AS (
				SELECT
					target_id,
					time_bucket($1::interval, bucket) AS ts,
					probe_id,
					MIN(min_us) AS min_us,
					MAX(max_us) AS max_us,
					SUM(sum_jitter_us) AS sum_jitter_us,
					SUM(sample_count) AS sample_count,
					SUM(loss_count) AS loss_count,
					rollup(pct_agg) AS pct
				FROM agg_1h
				WHERE %s
				GROUP BY target_id, ts, probe_id
			)
			SELECT
				target_id,
				probe_id,
				EXTRACT(EPOCH FROM ts)::BIGINT AS unix_sec,
				CASE WHEN min_us IS NOT NULL THEN min_us / 1000.0 END,
				CASE WHEN pct IS NOT NULL THEN approx_percentile(0.25, pct) / 1000.0 END,
				CASE WHEN pct IS NOT NULL THEN approx_percentile(0.50, pct) / 1000.0 END,
				CASE WHEN pct IS NOT NULL THEN approx_percentile(0.75, pct) / 1000.0 END,
				CASE WHEN pct IS NOT NULL THEN approx_percentile(0.95, pct) / 1000.0 END,
				CASE WHEN max_us IS NOT NULL THEN max_us / 1000.0 END,
				CASE WHEN (sample_count - loss_count) > 0 THEN (sum_jitter_us::DOUBLE PRECISION / (sample_count - loss_count)) / 1000.0 END,
				CASE WHEN sample_count > 0 THEN (loss_count::DOUBLE PRECISION * 100.0) / sample_count ELSE 0 END
			FROM rolled
			ORDER BY target_id ASC, probe_id ASC, ts ASC
		`, where)
	}
}

func (s *Store) QueryTargetSeries(ctx context.Context, targetID uuid.UUID, rangeKey string) (TargetSeriesResponse, error) {
	target, err := s.GetTarget(ctx, targetID)
	if err != nil {
		return TargetSeriesResponse{}, err
	}

	if rangeKey == "" {
		rangeKey = "5m"
	}
	spec := resolveRange(rangeKey)

	probes, err := s.ListProbes(ctx)
	if err != nil {
		return TargetSeriesResponse{}, err
	}

	ordered, seriesMap := initTargetProbeSeries(target, probes)
	nowUTC := time.Now().UTC()
	since := nowUTC.Add(-spec.window)
	query := seriesSQLQuery(spec, false)

	var args []any
	switch spec.source {
	case "raw", "agg_6h":
		args = []any{fmt.Sprintf("%d seconds", spec.bucketSec), targetID, since}
	case "agg_1m", "agg_5m":
		tailSince := nowUTC.Add(-6 * time.Hour)
		if since.After(tailSince) {
			tailSince = since
		}
		args = []any{fmt.Sprintf("%d seconds", spec.bucketSec), targetID, since, tailSince}
	default:
		args = []any{targetID, since}
	}

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return TargetSeriesResponse{}, fmt.Errorf("query series (%s): %w", spec.source, err)
	}
	defer rows.Close()

	if err := scanSeriesRows(rows, func(_ uuid.UUID, pid uuid.UUID) (*ProbeSeries, bool) {
		ps, ok := seriesMap[pid]
		return ps, ok
	}); err != nil {
		return TargetSeriesResponse{}, err
	}

	outSeries := make([]ProbeSeries, 0, len(ordered))
	for _, ps := range ordered {
		outSeries = append(outSeries, *ps)
	}

	return TargetSeriesResponse{
		Target:    target,
		Range:     rangeKey,
		BucketSec: spec.bucketSec,
		Series:    outSeries,
	}, nil
}

// QueryBatchTargetSeries fetches quantile time-series across multiple enabled targets in one query for TV wallboards.
func (s *Store) QueryBatchTargetSeries(ctx context.Context, targetIDs []uuid.UUID, rangeKey string) (BatchSeriesResponse, error) {
	if rangeKey == "" {
		rangeKey = "3h"
	}
	spec := resolveRange(rangeKey)

	result := BatchSeriesResponse{
		Range:     rangeKey,
		BucketSec: spec.bucketSec,
		Targets:   make(map[string][]ProbeSeries),
	}

	allTargets, err := s.ListTargets(ctx)
	if err != nil {
		return result, err
	}
	probes, err := s.ListProbes(ctx)
	if err != nil {
		return result, err
	}

	wanted := make(map[uuid.UUID]bool, len(targetIDs))
	for _, id := range targetIDs {
		wanted[id] = true
	}

	type targetBucket struct {
		ordered []*ProbeSeries
		byProbe map[uuid.UUID]*ProbeSeries
	}
	filteredIDs := make([]uuid.UUID, 0, len(allTargets))
	targetMap := make(map[uuid.UUID]*targetBucket)

	for _, t := range allTargets {
		if !t.Enabled {
			continue
		}
		if len(wanted) > 0 && !wanted[t.ID] {
			continue
		}
		ordered, byProbe := initTargetProbeSeries(t, probes)
		targetMap[t.ID] = &targetBucket{ordered: ordered, byProbe: byProbe}
		filteredIDs = append(filteredIDs, t.ID)
	}

	if len(filteredIDs) == 0 {
		return result, nil
	}

	nowUTC := time.Now().UTC()
	since := nowUTC.Add(-spec.window)
	query := seriesSQLQuery(spec, true)

	var args []any
	switch spec.source {
	case "raw", "agg_6h":
		args = []any{fmt.Sprintf("%d seconds", spec.bucketSec), filteredIDs, since}
	case "agg_1m", "agg_5m":
		tailSince := nowUTC.Add(-6 * time.Hour)
		if since.After(tailSince) {
			tailSince = since
		}
		args = []any{fmt.Sprintf("%d seconds", spec.bucketSec), filteredIDs, since, tailSince}
	default:
		args = []any{filteredIDs, since}
	}

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return result, fmt.Errorf("query batch series (%s): %w", spec.source, err)
	}
	defer rows.Close()

	if err := scanSeriesRows(rows, func(tid, pid uuid.UUID) (*ProbeSeries, bool) {
		tb, ok := targetMap[tid]
		if !ok {
			return nil, false
		}
		ps, ok := tb.byProbe[pid]
		return ps, ok
	}); err != nil {
		return result, err
	}

	for tid, tb := range targetMap {
		out := make([]ProbeSeries, 0, len(tb.ordered))
		for _, ps := range tb.ordered {
			out = append(out, *ps)
		}
		result.Targets[tid.String()] = out
	}
	return result, nil
}

type seriesScanner interface {
	Next() bool
	Scan(dest ...any) error
	Err() error
}

func scanSeriesRows(rows seriesScanner, lookup func(tid, pid uuid.UUID) (*ProbeSeries, bool)) error {
	for rows.Next() {
		var tid, pid uuid.UUID
		var ts int64
		var minMs, p25Ms, p50Ms, p75Ms, p95Ms, maxMs, jitterMs *float64
		var lossPct float64
		if err := rows.Scan(&tid, &pid, &ts, &minMs, &p25Ms, &p50Ms, &p75Ms, &p95Ms, &maxMs, &jitterMs, &lossPct); err != nil {
			return err
		}
		ps, ok := lookup(tid, pid)
		if !ok {
			continue
		}
		ps.Timestamps = append(ps.Timestamps, ts)
		ps.MinMs = append(ps.MinMs, minMs)
		ps.P25Ms = append(ps.P25Ms, p25Ms)
		ps.P50Ms = append(ps.P50Ms, p50Ms)
		ps.P75Ms = append(ps.P75Ms, p75Ms)
		ps.P95Ms = append(ps.P95Ms, p95Ms)
		ps.MaxMs = append(ps.MaxMs, maxMs)
		ps.JitterMs = append(ps.JitterMs, jitterMs)
		ps.LossPct = append(ps.LossPct, lossPct)
	}
	return rows.Err()
}
