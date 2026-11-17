SET lock_timeout = '3s';

ALTER TABLE alert_rules
    ADD COLUMN IF NOT EXISTS confirm_sec INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS recover_sec INTEGER NOT NULL DEFAULT 45;

ALTER TABLE alert_rules DROP CONSTRAINT IF EXISTS alert_rules_confirm_sec_check;
ALTER TABLE alert_rules
    ADD CONSTRAINT alert_rules_confirm_sec_check
    CHECK (confirm_sec >= 0 AND confirm_sec <= 3600);

ALTER TABLE alert_rules DROP CONSTRAINT IF EXISTS alert_rules_recover_sec_check;
ALTER TABLE alert_rules
    ADD CONSTRAINT alert_rules_recover_sec_check
    CHECK (recover_sec >= 0 AND recover_sec <= 3600);
