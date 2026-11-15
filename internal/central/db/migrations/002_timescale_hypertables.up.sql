-- migrate:no-tx

CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS timescaledb_toolkit;

CREATE TABLE IF NOT EXISTS ping_samples (
    time      TIMESTAMPTZ NOT NULL,
    probe_id  UUID        NOT NULL,
    target_id UUID        NOT NULL,
    rtt_us    INTEGER,
    jitter_us INTEGER     NOT NULL DEFAULT 0,
    is_loss   BOOLEAN     NOT NULL DEFAULT FALSE,
    PRIMARY KEY (target_id, probe_id, time)
);

SELECT create_hypertable('ping_samples', by_range('time', INTERVAL '1 day'), if_not_exists => TRUE);

ALTER TABLE ping_samples SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'target_id, probe_id',
    timescaledb.compress_orderby = 'time DESC'
);

SELECT add_compression_policy('ping_samples', INTERVAL '1 day', if_not_exists => TRUE);
SELECT add_retention_policy('ping_samples', INTERVAL '14 days', if_not_exists => TRUE);

CREATE MATERIALIZED VIEW IF NOT EXISTS agg_1m
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 minute', time) AS bucket,
    target_id,
    probe_id,
    MIN(rtt_us) FILTER (WHERE NOT is_loss AND rtt_us IS NOT NULL)::INTEGER AS min_us,
    MAX(rtt_us) FILTER (WHERE NOT is_loss AND rtt_us IS NOT NULL)::INTEGER AS max_us,
    SUM(jitter_us) FILTER (WHERE NOT is_loss)::BIGINT AS sum_jitter_us,
    COUNT(*)::INTEGER AS sample_count,
    COUNT(*) FILTER (WHERE is_loss)::INTEGER AS loss_count,
    percentile_agg(rtt_us::DOUBLE PRECISION) FILTER (WHERE NOT is_loss AND rtt_us IS NOT NULL) AS pct_agg
FROM ping_samples
GROUP BY bucket, target_id, probe_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy('agg_1m',
    start_offset => INTERVAL '2 hours',
    end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute',
    if_not_exists => TRUE);

ALTER MATERIALIZED VIEW agg_1m SET (
    timescaledb.compress = true,
    timescaledb.compress_segmentby = 'target_id, probe_id',
    timescaledb.compress_orderby = 'bucket DESC'
);

SELECT add_compression_policy('agg_1m', INTERVAL '7 days', if_not_exists => TRUE);
SELECT add_retention_policy('agg_1m', INTERVAL '730 days', if_not_exists => TRUE);

CREATE MATERIALIZED VIEW IF NOT EXISTS agg_5m
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('5 minutes', bucket) AS bucket,
    target_id,
    probe_id,
    MIN(min_us)::INTEGER AS min_us,
    MAX(max_us)::INTEGER AS max_us,
    SUM(sum_jitter_us)::BIGINT AS sum_jitter_us,
    SUM(sample_count)::INTEGER AS sample_count,
    SUM(loss_count)::INTEGER AS loss_count,
    rollup(pct_agg) AS pct_agg
FROM agg_1m
GROUP BY time_bucket('5 minutes', bucket), target_id, probe_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy('agg_5m',
    start_offset => INTERVAL '6 hours',
    end_offset => INTERVAL '5 minutes',
    schedule_interval => INTERVAL '5 minutes',
    if_not_exists => TRUE);

ALTER MATERIALIZED VIEW agg_5m SET (
    timescaledb.compress = true,
    timescaledb.compress_segmentby = 'target_id, probe_id',
    timescaledb.compress_orderby = 'bucket DESC'
);

SELECT add_compression_policy('agg_5m', INTERVAL '14 days', if_not_exists => TRUE);
SELECT add_retention_policy('agg_5m', INTERVAL '730 days', if_not_exists => TRUE);

CREATE MATERIALIZED VIEW IF NOT EXISTS agg_1h
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 hour', bucket) AS bucket,
    target_id,
    probe_id,
    MIN(min_us)::INTEGER AS min_us,
    MAX(max_us)::INTEGER AS max_us,
    SUM(sum_jitter_us)::BIGINT AS sum_jitter_us,
    SUM(sample_count)::INTEGER AS sample_count,
    SUM(loss_count)::INTEGER AS loss_count,
    rollup(pct_agg) AS pct_agg
FROM agg_5m
GROUP BY time_bucket('1 hour', bucket), target_id, probe_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy('agg_1h',
    start_offset => INTERVAL '1 day',
    end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '30 minutes',
    if_not_exists => TRUE);

ALTER MATERIALIZED VIEW agg_1h SET (
    timescaledb.compress = true,
    timescaledb.compress_segmentby = 'target_id, probe_id',
    timescaledb.compress_orderby = 'bucket DESC'
);

SELECT add_compression_policy('agg_1h', INTERVAL '30 days', if_not_exists => TRUE);
SELECT add_retention_policy('agg_1h', INTERVAL '730 days', if_not_exists => TRUE);
