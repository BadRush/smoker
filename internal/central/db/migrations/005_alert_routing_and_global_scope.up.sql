SET lock_timeout = '3s';

DO $$
DECLARE
    c RECORD;
BEGIN
    FOR c IN
        SELECT conname, pg_get_constraintdef(oid) AS def
        FROM pg_constraint
        WHERE conrelid = 'alert_rules'::regclass AND contype = 'c'
    LOOP
        IF c.def LIKE '%cooldown_sec%'
           OR c.def LIKE '%target_id IS NOT NULL%'
           OR c.def LIKE '%probe_offline%' THEN
            IF c.conname <> 'alert_rules_metric_check' THEN
                EXECUTE format('ALTER TABLE alert_rules DROP CONSTRAINT IF EXISTS %I', c.conname);
            END IF;
        END IF;
    END LOOP;
END $$;

ALTER TABLE alert_rules
    ALTER COLUMN cooldown_sec SET DEFAULT 0;

ALTER TABLE alert_rules
    ADD CONSTRAINT alert_rules_cooldown_sec_check
    CHECK (cooldown_sec = 0 OR (cooldown_sec >= 10 AND cooldown_sec <= 86400));

ALTER TABLE alert_rules
    ADD COLUMN IF NOT EXISTS channel_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE incidents
    ADD COLUMN IF NOT EXISTS severity TEXT NOT NULL DEFAULT 'warn';

ALTER TABLE incidents DROP CONSTRAINT IF EXISTS incidents_severity_check;
ALTER TABLE incidents
    ADD CONSTRAINT incidents_severity_check CHECK (severity IN ('warn', 'critical'));
