SET lock_timeout = '3s';

ALTER TABLE targets DROP CONSTRAINT IF EXISTS targets_probe_type_check;
ALTER TABLE targets ADD CONSTRAINT targets_probe_type_check
    CHECK (probe_type IN ('icmp', 'icmp6', 'tcp', 'tcp6', 'http', 'http6', 'dns', 'dns6'));
