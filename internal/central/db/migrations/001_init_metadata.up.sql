SET lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS admin_config (
    id            INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    username      TEXT        NOT NULL,
    password_hash TEXT        NOT NULL,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS system_settings (
    id                 INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    raw_retention_days INTEGER     NOT NULL DEFAULT 14 CHECK (raw_retention_days BETWEEN 1 AND 90),
    agg_retention_days INTEGER     NOT NULL DEFAULT 730 CHECK (agg_retention_days BETWEEN 30 AND 3650),
    default_quorum_min INTEGER     NOT NULL DEFAULT 2 CHECK (default_quorum_min >= 1),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS probes (
    id                    UUID PRIMARY KEY,
    name                  TEXT             NOT NULL,
    location_label        TEXT             NOT NULL DEFAULT '',
    isp_asn               TEXT             NOT NULL DEFAULT '',
    token_hash            TEXT             NOT NULL UNIQUE,
    is_local              BOOLEAN          NOT NULL DEFAULT FALSE,
    status                TEXT             NOT NULL DEFAULT 'offline'
                          CHECK (status IN ('online', 'buffering', 'syncing', 'offline')),
    pending_backlog_count BIGINT           NOT NULL DEFAULT 0 CHECK (pending_backlog_count >= 0),
    clock_offset_ms       DOUBLE PRECISION NOT NULL DEFAULT 0,
    last_seen_at          TIMESTAMPTZ,
    agent_version         TEXT             NOT NULL DEFAULT '',
    created_at            TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS target_groups (
    id          UUID PRIMARY KEY,
    name        TEXT        NOT NULL,
    parent_id   UUID        REFERENCES target_groups(id) ON DELETE SET NULL,
    description TEXT        NOT NULL DEFAULT '',
    sort_order  INTEGER     NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_target_groups_parent_id ON target_groups(parent_id);

CREATE TABLE IF NOT EXISTS targets (
    id                 UUID PRIMARY KEY,
    group_id           UUID        REFERENCES target_groups(id) ON DELETE SET NULL,
    name               TEXT        NOT NULL,
    host               TEXT        NOT NULL,
    probe_type         TEXT        NOT NULL CHECK (probe_type IN ('icmp', 'tcp', 'http', 'dns')),
    port_or_path       TEXT        NOT NULL DEFAULT '',
    interval_sec       INTEGER     NOT NULL DEFAULT 1 CHECK (interval_sec BETWEEN 1 AND 300),
    timeout_ms         INTEGER     NOT NULL DEFAULT 1000 CHECK (timeout_ms BETWEEN 100 AND 10000),
    enabled            BOOLEAN     NOT NULL DEFAULT TRUE,
    auto_mtr_on_loss   BOOLEAN     NOT NULL DEFAULT TRUE,
    mtr_loss_threshold INTEGER     NOT NULL DEFAULT 3 CHECK (mtr_loss_threshold BETWEEN 1 AND 60),
    assign_all_probes  BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_targets_group_id ON targets(group_id);
CREATE INDEX IF NOT EXISTS idx_targets_enabled ON targets(enabled) WHERE enabled = TRUE;

CREATE TABLE IF NOT EXISTS probe_target_assignments (
    probe_id  UUID NOT NULL REFERENCES probes(id) ON DELETE CASCADE,
    target_id UUID NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
    PRIMARY KEY (probe_id, target_id)
);

CREATE INDEX IF NOT EXISTS idx_pta_target_id ON probe_target_assignments(target_id);

CREATE TABLE IF NOT EXISTS alert_rules (
    id                UUID PRIMARY KEY,
    name              TEXT             NOT NULL,
    target_id         UUID             REFERENCES targets(id) ON DELETE CASCADE,
    group_id          UUID             REFERENCES target_groups(id) ON DELETE CASCADE,
    metric            TEXT             NOT NULL CHECK (metric IN ('latency_p95', 'loss_pct', 'jitter', 'probe_offline')),
    threshold_value   DOUBLE PRECISION NOT NULL CHECK (threshold_value >= 0),
    duration_sec      INTEGER          NOT NULL DEFAULT 30 CHECK (duration_sec BETWEEN 5 AND 3600),
    quorum_min_probes INTEGER          NOT NULL DEFAULT 1 CHECK (quorum_min_probes >= 1),
    cooldown_sec      INTEGER          NOT NULL DEFAULT 300 CHECK (cooldown_sec BETWEEN 10 AND 86400),
    enabled           BOOLEAN          NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
    CHECK (target_id IS NOT NULL OR group_id IS NOT NULL OR metric = 'probe_offline')
);

CREATE INDEX IF NOT EXISTS idx_alert_rules_target_id ON alert_rules(target_id);
CREATE INDEX IF NOT EXISTS idx_alert_rules_group_id ON alert_rules(group_id);

CREATE TABLE IF NOT EXISTS alert_channels (
    id               UUID PRIMARY KEY,
    type             TEXT        NOT NULL CHECK (type IN ('telegram', 'webhook')),
    name             TEXT        NOT NULL,
    config_encrypted BYTEA       NOT NULL,
    config_hint      TEXT        NOT NULL DEFAULT '',
    enabled          BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS incidents (
    id               UUID PRIMARY KEY,
    rule_id          UUID             NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
    target_id        UUID             REFERENCES targets(id) ON DELETE CASCADE,
    status           TEXT             NOT NULL CHECK (status IN ('open', 'resolved')),
    affected_probes  JSONB            NOT NULL DEFAULT '[]'::jsonb,
    peak_value       DOUBLE PRECISION NOT NULL DEFAULT 0,
    started_at       TIMESTAMPTZ      NOT NULL,
    resolved_at      TIMESTAMPTZ,
    last_notified_at TIMESTAMPTZ,
    summary          TEXT             NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_incidents_open_unique
    ON incidents (rule_id, COALESCE(target_id, '00000000-0000-0000-0000-000000000000'::uuid))
    WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_incidents_status_started ON incidents(status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_incidents_target_id ON incidents(target_id);

CREATE TABLE IF NOT EXISTS mtr_snapshots (
    id             UUID PRIMARY KEY,
    probe_id       UUID        NOT NULL REFERENCES probes(id) ON DELETE CASCADE,
    target_id      UUID        NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
    captured_at    TIMESTAMPTZ NOT NULL,
    trigger_reason TEXT        NOT NULL CHECK (trigger_reason IN ('auto_loss', 'manual')),
    hops_jsonb     JSONB       NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mtr_snapshots_target_time ON mtr_snapshots(target_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_mtr_snapshots_probe_id ON mtr_snapshots(probe_id);
