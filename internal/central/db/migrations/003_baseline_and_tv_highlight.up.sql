SET lock_timeout = '3s';

ALTER TABLE alert_rules DROP CONSTRAINT IF EXISTS alert_rules_metric_check;
ALTER TABLE alert_rules ADD CONSTRAINT alert_rules_metric_check
    CHECK (metric IN ('latency_p95', 'loss_pct', 'jitter', 'probe_offline', 'baseline_spike_pct'));

ALTER TABLE targets ADD COLUMN IF NOT EXISTS pinned_on_tv BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE targets ADD COLUMN IF NOT EXISTS latency_warn_ms INTEGER NOT NULL DEFAULT 0 CHECK (latency_warn_ms >= 0 AND latency_warn_ms <= 10000);
ALTER TABLE targets ADD COLUMN IF NOT EXISTS probe_latency_overrides JSONB NOT NULL DEFAULT '{}'::jsonb;
