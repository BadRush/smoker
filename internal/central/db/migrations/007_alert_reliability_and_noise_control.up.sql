SET lock_timeout = '3s';

ALTER TABLE alert_channels
    ADD COLUMN IF NOT EXISTS severity_filter TEXT NOT NULL DEFAULT 'all';

ALTER TABLE alert_channels DROP CONSTRAINT IF EXISTS alert_channels_severity_filter_check;
ALTER TABLE alert_channels
    ADD CONSTRAINT alert_channels_severity_filter_check
    CHECK (severity_filter IN ('all', 'critical'));

ALTER TABLE incidents
    ADD COLUMN IF NOT EXISTS notified_severity TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS telegram_message_ids JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS acknowledged_by TEXT NOT NULL DEFAULT '';

ALTER TABLE targets
    ADD COLUMN IF NOT EXISTS muted_until TIMESTAMPTZ;
