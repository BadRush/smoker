package db

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"smoker/internal/central/auth"
	"smoker/internal/central/config"
	"smoker/internal/protocol"
)

type Store struct {
	pool *pgxpool.Pool
}

func NewPool(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse db url: %w", err)
	}
	cfg.MaxConns = 20
	cfg.MinConns = 2
	cfg.MaxConnLifetime = 30 * time.Minute
	cfg.MaxConnLifetimeJitter = 5 * time.Minute
	cfg.HealthCheckPeriod = time.Minute

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("create pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping db: %w", err)
	}
	return pool, nil
}

func NewStore(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

func (s *Store) Pool() *pgxpool.Pool {
	return s.pool
}

func (s *Store) Ping(ctx context.Context) error {
	return s.pool.Ping(ctx)
}

func newUUIDv7() uuid.UUID {
	id, err := uuid.NewV7()
	if err != nil {
		return uuid.New()
	}
	return id
}

func mapPGError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505":
			return ErrConflict
		case "23503", "23514", "22P02":
			return ErrInvalidInput
		}
	}
	return err
}

func (s *Store) EnsureBootstrap(ctx context.Context, cfg config.CentralConfig) error {
	var hasAdmin bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM admin_config WHERE id = 1)`).Scan(&hasAdmin); err != nil {
		return fmt.Errorf("check admin_config: %w", err)
	}
	if !hasAdmin {
		hash, err := auth.HashPassword(cfg.AdminPassword)
		if err != nil {
			return fmt.Errorf("hash bootstrap admin password: %w", err)
		}
		if _, err := s.pool.Exec(ctx, `
			INSERT INTO admin_config (id, username, password_hash, updated_at)
			VALUES (1, $1, $2, NOW())
			ON CONFLICT (id) DO NOTHING
		`, cfg.AdminUsername, hash); err != nil {
			return fmt.Errorf("seed admin_config: %w", err)
		}
	}

	if _, err := s.pool.Exec(ctx, `
		ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS brand_name TEXT NOT NULL DEFAULT '';
		INSERT INTO system_settings (id, raw_retention_days, agg_retention_days, default_quorum_min, brand_name, updated_at)
		VALUES (1, 14, 730, 2, '', NOW())
		ON CONFLICT (id) DO NOTHING;
		ALTER TABLE mtr_snapshots DROP CONSTRAINT IF EXISTS mtr_snapshots_trigger_reason_check;
		ALTER TABLE mtr_snapshots ADD CONSTRAINT mtr_snapshots_trigger_reason_check CHECK (trigger_reason IN ('auto_loss', 'auto_latency', 'manual'));
	`); err != nil {
		return fmt.Errorf("seed system_settings: %w", err)
	}

	if cfg.LocalProbeAutoEnroll {
		tokenHash := auth.HashProbeToken(cfg.LocalProbeToken)
		var exists bool
		if err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM probes WHERE is_local = TRUE)`).Scan(&exists); err != nil {
			return fmt.Errorf("check local probe: %w", err)
		}
		if !exists {
			id := newUUIDv7()
			if _, err := s.pool.Exec(ctx, `
				INSERT INTO probes (id, name, location_label, isp_asn, token_hash, is_local, status)
				VALUES ($1, $2, $3, 'LOCAL', $4, TRUE, 'offline')
				ON CONFLICT (token_hash) DO NOTHING
			`, id, cfg.LocalProbeName, cfg.LocalProbeLocation, tokenHash); err != nil {
				return fmt.Errorf("seed local probe: %w", err)
			}
		} else {
			if _, err := s.pool.Exec(ctx, `
				UPDATE probes SET token_hash = $1
				WHERE is_local = TRUE
			`, tokenHash); err != nil {
				return fmt.Errorf("sync local probe token: %w", err)
			}
		}
	}

	if cfg.SeedPublicMonitors {
		if _, err := s.SeedPublicMonitors(ctx, true); err != nil {
			return fmt.Errorf("seed public monitors: %w", err)
		}
		var hasIPv6Group bool
		if err := s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM target_groups WHERE LOWER(name) = 'public ipv6')`).Scan(&hasIPv6Group); err == nil && !hasIPv6Group {
			if _, err := s.SeedPublicMonitors(ctx, false); err != nil {
				return fmt.Errorf("seed public ipv6 monitors: %w", err)
			}
		}
	}

	return nil
}

func (s *Store) GetAdminByUsername(ctx context.Context, username string) (AdminUser, error) {
	var u AdminUser
	err := s.pool.QueryRow(ctx, `
		SELECT username, password_hash, updated_at FROM admin_config WHERE id = 1 AND username = $1
	`, username).Scan(&u.Username, &u.PasswordHash, &u.UpdatedAt)
	if err != nil {
		return u, mapPGError(err)
	}
	return u, nil
}

func (s *Store) UpdateAdminPassword(ctx context.Context, username, newHash string) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE admin_config SET password_hash = $1, updated_at = NOW() WHERE id = 1 AND username = $2
	`, newHash, username)
	if err != nil {
		return mapPGError(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// --- Probes ---

func (s *Store) ListProbes(ctx context.Context) ([]Probe, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, name, location_label, isp_asn, is_local, status,
		       pending_backlog_count, clock_offset_ms, last_seen_at, agent_version, created_at
		FROM probes
		ORDER BY is_local DESC, created_at ASC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]Probe, 0)
	for rows.Next() {
		var p Probe
		if err := rows.Scan(
			&p.ID, &p.Name, &p.LocationLabel, &p.ISPAsn, &p.IsLocal, &p.Status,
			&p.PendingBacklogCount, &p.ClockOffsetMs, &p.LastSeenAt, &p.AgentVersion, &p.CreatedAt,
		); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func scanProbe(row pgx.Row) (Probe, error) {
	var p Probe
	err := row.Scan(
		&p.ID, &p.Name, &p.LocationLabel, &p.ISPAsn, &p.IsLocal, &p.Status,
		&p.PendingBacklogCount, &p.ClockOffsetMs, &p.LastSeenAt, &p.AgentVersion, &p.CreatedAt,
	)
	return p, err
}

func (s *Store) GetProbeByTokenHash(ctx context.Context, tokenHash string) (Probe, error) {
	p, err := scanProbe(s.pool.QueryRow(ctx, `
		SELECT id, name, location_label, isp_asn, is_local, status,
		       pending_backlog_count, clock_offset_ms, last_seen_at, agent_version, created_at
		FROM probes WHERE token_hash = $1
	`, tokenHash))
	if err != nil {
		return p, mapPGError(err)
	}
	return p, nil
}

func (s *Store) CreateProbe(ctx context.Context, name, locationLabel, ispASN, tokenHash string) (Probe, error) {
	id := newUUIDv7()
	p, err := scanProbe(s.pool.QueryRow(ctx, `
		INSERT INTO probes (id, name, location_label, isp_asn, token_hash, is_local, status)
		VALUES ($1, $2, $3, $4, $5, FALSE, 'offline')
		RETURNING id, name, location_label, isp_asn, is_local, status,
		          pending_backlog_count, clock_offset_ms, last_seen_at, agent_version, created_at
	`, id, name, locationLabel, ispASN, tokenHash))
	if err != nil {
		return p, mapPGError(err)
	}
	return p, nil
}

func (s *Store) UpdateProbe(ctx context.Context, id uuid.UUID, name, locationLabel, ispASN string) (Probe, error) {
	p, err := scanProbe(s.pool.QueryRow(ctx, `
		UPDATE probes
		SET name = $2, location_label = $3, isp_asn = $4
		WHERE id = $1
		RETURNING id, name, location_label, isp_asn, is_local, status,
		          pending_backlog_count, clock_offset_ms, last_seen_at, agent_version, created_at
	`, id, name, locationLabel, ispASN))
	if err != nil {
		return p, mapPGError(err)
	}
	return p, nil
}

func (s *Store) RotateProbeToken(ctx context.Context, id uuid.UUID, tokenHash string) (Probe, error) {
	p, err := scanProbe(s.pool.QueryRow(ctx, `
		UPDATE probes SET token_hash = $2
		WHERE id = $1
		RETURNING id, name, location_label, isp_asn, is_local, status,
		          pending_backlog_count, clock_offset_ms, last_seen_at, agent_version, created_at
	`, id, tokenHash))
	if err != nil {
		return p, mapPGError(err)
	}
	return p, nil
}

func (s *Store) DeleteProbe(ctx context.Context, id uuid.UUID) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
		SELECT t.name
		FROM targets t
		WHERE t.enabled = TRUE
		  AND t.assign_all_probes = FALSE
		  AND EXISTS (
			SELECT 1 FROM probe_target_assignments pta
			WHERE pta.target_id = t.id AND pta.probe_id = $1
		  )
		  AND NOT EXISTS (
			SELECT 1 FROM probe_target_assignments pta2
			WHERE pta2.target_id = t.id AND pta2.probe_id <> $1
		  )
		ORDER BY t.name ASC
	`, id)
	if err != nil {
		return mapPGError(err)
	}
	var blockingNames []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			return err
		}
		blockingNames = append(blockingNames, name)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()

	if len(blockingNames) > 0 {
		return &ProbeInUseError{TargetNames: blockingNames}
	}

	tag, err := tx.Exec(ctx, `DELETE FROM probes WHERE id = $1 AND is_local = FALSE`, id)
	if err != nil {
		return mapPGError(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

func (s *Store) UpdateProbePresence(ctx context.Context, id uuid.UUID, status string, backlog int64, offsetMs float64, version string, seenAt time.Time) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE probes
		SET status = $2,
		    pending_backlog_count = $3,
		    clock_offset_ms = $4,
		    agent_version = CASE WHEN $5 <> '' THEN $5 ELSE agent_version END,
		    last_seen_at = $6
		WHERE id = $1
	`, id, status, backlog, offsetMs, version, seenAt)
	return err
}

func (s *Store) MarkStaleProbesOffline(ctx context.Context, cutoff time.Time) ([]uuid.UUID, error) {
	rows, err := s.pool.Query(ctx, `
		UPDATE probes
		SET status = 'offline'
		WHERE status <> 'offline' AND (last_seen_at IS NULL OR last_seen_at < $1)
		RETURNING id
	`, cutoff)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// --- Target Groups ---

func (s *Store) ListGroups(ctx context.Context) ([]TargetGroup, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, name, parent_id, description, sort_order, created_at
		FROM target_groups
		ORDER BY sort_order ASC, name ASC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]TargetGroup, 0)
	for rows.Next() {
		var g TargetGroup
		if err := rows.Scan(&g.ID, &g.Name, &g.ParentID, &g.Description, &g.SortOrder, &g.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

func (s *Store) CreateGroup(ctx context.Context, name string, parentID *uuid.UUID, desc string, sortOrder int) (TargetGroup, error) {
	id := newUUIDv7()
	var g TargetGroup
	err := s.pool.QueryRow(ctx, `
		INSERT INTO target_groups (id, name, parent_id, description, sort_order)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id, name, parent_id, description, sort_order, created_at
	`, id, name, parentID, desc, sortOrder).Scan(&g.ID, &g.Name, &g.ParentID, &g.Description, &g.SortOrder, &g.CreatedAt)
	return g, mapPGError(err)
}

func (s *Store) UpdateGroup(ctx context.Context, id uuid.UUID, name string, parentID *uuid.UUID, desc string, sortOrder int) (TargetGroup, error) {
	var g TargetGroup
	err := s.pool.QueryRow(ctx, `
		UPDATE target_groups
		SET name = $2, parent_id = $3, description = $4, sort_order = $5
		WHERE id = $1
		RETURNING id, name, parent_id, description, sort_order, created_at
	`, id, name, parentID, desc, sortOrder).Scan(&g.ID, &g.Name, &g.ParentID, &g.Description, &g.SortOrder, &g.CreatedAt)
	return g, mapPGError(err)
}

func (s *Store) DeleteGroup(ctx context.Context, id uuid.UUID) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM target_groups WHERE id = $1`, id)
	if err != nil {
		return mapPGError(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// --- Targets ---

type TargetInput struct {
	GroupID               *uuid.UUID
	Name                  string
	Host                  string
	ProbeType             string
	PortOrPath            string
	IntervalSec           int
	TimeoutMs             int
	Enabled               bool
	AutoMTROnLoss         bool
	MTRLossThreshold      int
	AssignAllProbes       bool
	ProbeIDs              []uuid.UUID
	PinnedOnTV            bool
	LatencyWarnMs         int
	ProbeLatencyOverrides map[string]int
}

func (s *Store) ListTargets(ctx context.Context) ([]Target, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT t.id, t.group_id, t.name, t.host, t.probe_type, t.port_or_path,
		       t.interval_sec, t.timeout_ms, t.enabled, t.auto_mtr_on_loss,
		       t.mtr_loss_threshold, t.assign_all_probes, t.pinned_on_tv,
		       t.latency_warn_ms, t.probe_latency_overrides, t.created_at, t.updated_at,
		       COALESCE(ARRAY(SELECT pta.probe_id FROM probe_target_assignments pta WHERE pta.target_id = t.id), '{}')
		FROM targets t
		ORDER BY t.name ASC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]Target, 0)
	for rows.Next() {
		var t Target
		var overridesRaw []byte
		if err := rows.Scan(
			&t.ID, &t.GroupID, &t.Name, &t.Host, &t.ProbeType, &t.PortOrPath,
			&t.IntervalSec, &t.TimeoutMs, &t.Enabled, &t.AutoMTROnLoss,
			&t.MTRLossThreshold, &t.AssignAllProbes, &t.PinnedOnTV,
			&t.LatencyWarnMs, &overridesRaw, &t.CreatedAt, &t.UpdatedAt, &t.ProbeIDs,
		); err != nil {
			return nil, err
		}
		if t.ProbeIDs == nil {
			t.ProbeIDs = []uuid.UUID{}
		}
		t.ProbeLatencyOverrides = make(map[string]int)
		if len(overridesRaw) > 0 {
			_ = json.Unmarshal(overridesRaw, &t.ProbeLatencyOverrides)
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *Store) GetTarget(ctx context.Context, id uuid.UUID) (Target, error) {
	var t Target
	var overridesRaw []byte
	err := s.pool.QueryRow(ctx, `
		SELECT t.id, t.group_id, t.name, t.host, t.probe_type, t.port_or_path,
		       t.interval_sec, t.timeout_ms, t.enabled, t.auto_mtr_on_loss,
		       t.mtr_loss_threshold, t.assign_all_probes, t.pinned_on_tv,
		       t.latency_warn_ms, t.probe_latency_overrides, t.created_at, t.updated_at,
		       COALESCE(ARRAY(SELECT pta.probe_id FROM probe_target_assignments pta WHERE pta.target_id = t.id), '{}')
		FROM targets t
		WHERE t.id = $1
	`, id).Scan(
		&t.ID, &t.GroupID, &t.Name, &t.Host, &t.ProbeType, &t.PortOrPath,
		&t.IntervalSec, &t.TimeoutMs, &t.Enabled, &t.AutoMTROnLoss,
		&t.MTRLossThreshold, &t.AssignAllProbes, &t.PinnedOnTV,
		&t.LatencyWarnMs, &overridesRaw, &t.CreatedAt, &t.UpdatedAt, &t.ProbeIDs,
	)
	if err != nil {
		return t, mapPGError(err)
	}
	if t.ProbeIDs == nil {
		t.ProbeIDs = []uuid.UUID{}
	}
	t.ProbeLatencyOverrides = make(map[string]int)
	if len(overridesRaw) > 0 {
		_ = json.Unmarshal(overridesRaw, &t.ProbeLatencyOverrides)
	}
	return t, nil
}

func (s *Store) CreateTarget(ctx context.Context, in TargetInput) (Target, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Target{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	overridesMap := in.ProbeLatencyOverrides
	if overridesMap == nil {
		overridesMap = map[string]int{}
	}
	overridesJSON, err := json.Marshal(overridesMap)
	if err != nil {
		return Target{}, err
	}

	id := newUUIDv7()
	var t Target
	var overridesRaw []byte
	err = tx.QueryRow(ctx, `
		INSERT INTO targets (id, group_id, name, host, probe_type, port_or_path,
		                     interval_sec, timeout_ms, enabled, auto_mtr_on_loss,
		                     mtr_loss_threshold, assign_all_probes, pinned_on_tv,
		                     latency_warn_ms, probe_latency_overrides)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
		RETURNING id, group_id, name, host, probe_type, port_or_path,
		          interval_sec, timeout_ms, enabled, auto_mtr_on_loss,
		          mtr_loss_threshold, assign_all_probes, pinned_on_tv,
		          latency_warn_ms, probe_latency_overrides, created_at, updated_at
	`, id, in.GroupID, in.Name, in.Host, in.ProbeType, in.PortOrPath,
		in.IntervalSec, in.TimeoutMs, in.Enabled, in.AutoMTROnLoss,
		in.MTRLossThreshold, in.AssignAllProbes, in.PinnedOnTV,
		in.LatencyWarnMs, overridesJSON).Scan(
		&t.ID, &t.GroupID, &t.Name, &t.Host, &t.ProbeType, &t.PortOrPath,
		&t.IntervalSec, &t.TimeoutMs, &t.Enabled, &t.AutoMTROnLoss,
		&t.MTRLossThreshold, &t.AssignAllProbes, &t.PinnedOnTV,
		&t.LatencyWarnMs, &overridesRaw, &t.CreatedAt, &t.UpdatedAt,
	)
	if err != nil {
		return Target{}, mapPGError(err)
	}
	t.ProbeLatencyOverrides = overridesMap

	if !in.AssignAllProbes && len(in.ProbeIDs) > 0 {
		for _, pid := range in.ProbeIDs {
			if _, err := tx.Exec(ctx, `
				INSERT INTO probe_target_assignments (probe_id, target_id)
				VALUES ($1, $2) ON CONFLICT DO NOTHING
			`, pid, t.ID); err != nil {
				return Target{}, mapPGError(err)
			}
		}
		t.ProbeIDs = in.ProbeIDs
	} else {
		t.ProbeIDs = []uuid.UUID{}
	}

	if err := tx.Commit(ctx); err != nil {
		return Target{}, err
	}
	return t, nil
}

func (s *Store) UpdateTarget(ctx context.Context, id uuid.UUID, in TargetInput) (Target, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Target{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	overridesMap := in.ProbeLatencyOverrides
	if overridesMap == nil {
		overridesMap = map[string]int{}
	}
	overridesJSON, err := json.Marshal(overridesMap)
	if err != nil {
		return Target{}, err
	}

	var t Target
	var overridesRaw []byte
	err = tx.QueryRow(ctx, `
		UPDATE targets
		SET group_id = $2, name = $3, host = $4, probe_type = $5, port_or_path = $6,
		    interval_sec = $7, timeout_ms = $8, enabled = $9, auto_mtr_on_loss = $10,
		    mtr_loss_threshold = $11, assign_all_probes = $12, pinned_on_tv = $13,
		    latency_warn_ms = $14, probe_latency_overrides = $15, updated_at = NOW()
		WHERE id = $1
		RETURNING id, group_id, name, host, probe_type, port_or_path,
		          interval_sec, timeout_ms, enabled, auto_mtr_on_loss,
		          mtr_loss_threshold, assign_all_probes, pinned_on_tv,
		          latency_warn_ms, probe_latency_overrides, created_at, updated_at
	`, id, in.GroupID, in.Name, in.Host, in.ProbeType, in.PortOrPath,
		in.IntervalSec, in.TimeoutMs, in.Enabled, in.AutoMTROnLoss,
		in.MTRLossThreshold, in.AssignAllProbes, in.PinnedOnTV,
		in.LatencyWarnMs, overridesJSON).Scan(
		&t.ID, &t.GroupID, &t.Name, &t.Host, &t.ProbeType, &t.PortOrPath,
		&t.IntervalSec, &t.TimeoutMs, &t.Enabled, &t.AutoMTROnLoss,
		&t.MTRLossThreshold, &t.AssignAllProbes, &t.PinnedOnTV,
		&t.LatencyWarnMs, &overridesRaw, &t.CreatedAt, &t.UpdatedAt,
	)
	if err != nil {
		return Target{}, mapPGError(err)
	}
	t.ProbeLatencyOverrides = overridesMap

	if _, err := tx.Exec(ctx, `DELETE FROM probe_target_assignments WHERE target_id = $1`, id); err != nil {
		return Target{}, err
	}
	if !in.AssignAllProbes && len(in.ProbeIDs) > 0 {
		for _, pid := range in.ProbeIDs {
			if _, err := tx.Exec(ctx, `
				INSERT INTO probe_target_assignments (probe_id, target_id)
				VALUES ($1, $2) ON CONFLICT DO NOTHING
			`, pid, id); err != nil {
				return Target{}, mapPGError(err)
			}
		}
		t.ProbeIDs = in.ProbeIDs
	} else {
		t.ProbeIDs = []uuid.UUID{}
	}

	if err := tx.Commit(ctx); err != nil {
		return Target{}, err
	}
	return t, nil
}

func (s *Store) DeleteTarget(ctx context.Context, id uuid.UUID) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM targets WHERE id = $1`, id)
	if err != nil {
		return mapPGError(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) TargetsForProbe(ctx context.Context, probeID uuid.UUID) ([]protocol.TargetConfig, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT t.id, t.name, t.host, t.probe_type, t.port_or_path,
		       t.interval_sec, t.timeout_ms, t.auto_mtr_on_loss, t.mtr_loss_threshold,
		       t.latency_warn_ms, COALESCE(t.probe_latency_overrides, '{}'::jsonb)
		FROM targets t
		WHERE t.enabled = TRUE
		  AND (
			t.assign_all_probes = TRUE
			OR EXISTS (
				SELECT 1 FROM probe_target_assignments pta
				WHERE pta.target_id = t.id AND pta.probe_id = $1
			)
		  )
		ORDER BY t.id ASC
	`, probeID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	probeKey := probeID.String()
	out := make([]protocol.TargetConfig, 0)
	for rows.Next() {
		var id uuid.UUID
		var tc protocol.TargetConfig
		var overridesRaw []byte
		if err := rows.Scan(
			&id, &tc.Name, &tc.Host, &tc.ProbeType, &tc.PortOrPath,
			&tc.IntervalSec, &tc.TimeoutMs, &tc.AutoMTROnLoss, &tc.MTRLossThreshold,
			&tc.LatencyWarnMs, &overridesRaw,
		); err != nil {
			return nil, err
		}
		if len(overridesRaw) > 0 {
			var ov map[string]int
			if json.Unmarshal(overridesRaw, &ov) == nil {
				if customWarn, ok := ov[probeKey]; ok && customWarn > 0 {
					tc.LatencyWarnMs = customWarn
				}
			}
		}
		tc.ID = id.String()
		out = append(out, tc)
	}
	return out, rows.Err()
}

// --- MTR Snapshots ---

func (s *Store) InsertMTRSnapshot(ctx context.Context, probeID, targetID uuid.UUID, capturedAt time.Time, reason string, hops []protocol.MTRHop) (MTRSnapshot, error) {
	id := newUUIDv7()
	hopsJSON, err := json.Marshal(hops)
	if err != nil {
		return MTRSnapshot{}, err
	}
	var snap MTRSnapshot
	err = s.pool.QueryRow(ctx, `
		INSERT INTO mtr_snapshots (id, probe_id, target_id, captured_at, trigger_reason, hops_jsonb)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id, probe_id, target_id, captured_at, trigger_reason
	`, id, probeID, targetID, capturedAt, reason, hopsJSON).Scan(
		&snap.ID, &snap.ProbeID, &snap.TargetID, &snap.CapturedAt, &snap.TriggerReason,
	)
	if err != nil {
		return snap, mapPGError(err)
	}
	snap.Hops = hops
	return snap, nil
}

func (s *Store) ListMTRSnapshots(ctx context.Context, targetID uuid.UUID, limit int) ([]MTRSnapshot, error) {
	if limit <= 0 || limit > 100 {
		limit = 25
	}
	rows, err := s.pool.Query(ctx, `
		SELECT m.id, m.probe_id, COALESCE(p.name, 'Unknown'), m.target_id,
		       m.captured_at, m.trigger_reason, m.hops_jsonb
		FROM mtr_snapshots m
		LEFT JOIN probes p ON p.id = m.probe_id
		WHERE m.target_id = $1
		ORDER BY m.captured_at DESC
		LIMIT $2
	`, targetID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]MTRSnapshot, 0)
	for rows.Next() {
		var m MTRSnapshot
		var raw []byte
		if err := rows.Scan(&m.ID, &m.ProbeID, &m.ProbeName, &m.TargetID, &m.CapturedAt, &m.TriggerReason, &raw); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(raw, &m.Hops); err != nil {
			m.Hops = []protocol.MTRHop{}
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// --- Alerts & Incidents ---

type AlertRuleInput struct {
	Name            string
	TargetID        *uuid.UUID
	GroupID         *uuid.UUID
	Metric          string
	ThresholdValue  float64
	DurationSec     int
	QuorumMinProbes int
	CooldownSec     int
	ConfirmSec      int
	RecoverSec      int
	ChannelIDs      []uuid.UUID
	Enabled         bool
}

func normalizeUUIDSlice(in []uuid.UUID) []uuid.UUID {
	if len(in) == 0 {
		return []uuid.UUID{}
	}
	seen := make(map[uuid.UUID]bool, len(in))
	out := make([]uuid.UUID, 0, len(in))
	for _, id := range in {
		if id == uuid.Nil || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out
}

func decodeChannelIDs(raw []byte) []uuid.UUID {
	if len(raw) == 0 {
		return []uuid.UUID{}
	}
	var ids []uuid.UUID
	if err := json.Unmarshal(raw, &ids); err != nil {
		return []uuid.UUID{}
	}
	return normalizeUUIDSlice(ids)
}

func (s *Store) ListAlertRules(ctx context.Context) ([]AlertRule, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, name, target_id, group_id, metric, threshold_value,
		       duration_sec, quorum_min_probes, cooldown_sec, confirm_sec, recover_sec,
		       channel_ids, enabled, created_at
		FROM alert_rules
		ORDER BY created_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]AlertRule, 0)
	for rows.Next() {
		var r AlertRule
		var rawChannels []byte
		if err := rows.Scan(
			&r.ID, &r.Name, &r.TargetID, &r.GroupID, &r.Metric, &r.ThresholdValue,
			&r.DurationSec, &r.QuorumMinProbes, &r.CooldownSec, &r.ConfirmSec, &r.RecoverSec,
			&rawChannels, &r.Enabled, &r.CreatedAt,
		); err != nil {
			return nil, err
		}
		r.ChannelIDs = decodeChannelIDs(rawChannels)
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Store) CreateAlertRule(ctx context.Context, in AlertRuleInput) (AlertRule, error) {
	id := newUUIDv7()
	chIDs := normalizeUUIDSlice(in.ChannelIDs)
	chJSON, _ := json.Marshal(chIDs)
	var r AlertRule
	var rawChannels []byte
	err := s.pool.QueryRow(ctx, `
		INSERT INTO alert_rules (id, name, target_id, group_id, metric, threshold_value,
		                         duration_sec, quorum_min_probes, cooldown_sec, confirm_sec, recover_sec,
		                         channel_ids, enabled)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
		RETURNING id, name, target_id, group_id, metric, threshold_value,
		          duration_sec, quorum_min_probes, cooldown_sec, confirm_sec, recover_sec,
		          channel_ids, enabled, created_at
	`, id, in.Name, in.TargetID, in.GroupID, in.Metric, in.ThresholdValue,
		in.DurationSec, in.QuorumMinProbes, in.CooldownSec, in.ConfirmSec, in.RecoverSec,
		chJSON, in.Enabled).Scan(
		&r.ID, &r.Name, &r.TargetID, &r.GroupID, &r.Metric, &r.ThresholdValue,
		&r.DurationSec, &r.QuorumMinProbes, &r.CooldownSec, &r.ConfirmSec, &r.RecoverSec,
		&rawChannels, &r.Enabled, &r.CreatedAt,
	)
	r.ChannelIDs = decodeChannelIDs(rawChannels)
	return r, mapPGError(err)
}

func (s *Store) UpdateAlertRule(ctx context.Context, id uuid.UUID, in AlertRuleInput) (AlertRule, error) {
	chIDs := normalizeUUIDSlice(in.ChannelIDs)
	chJSON, _ := json.Marshal(chIDs)
	var r AlertRule
	var rawChannels []byte
	err := s.pool.QueryRow(ctx, `
		UPDATE alert_rules
		SET name = $2, target_id = $3, group_id = $4, metric = $5, threshold_value = $6,
		    duration_sec = $7, quorum_min_probes = $8, cooldown_sec = $9,
		    confirm_sec = $10, recover_sec = $11, channel_ids = $12, enabled = $13
		WHERE id = $1
		RETURNING id, name, target_id, group_id, metric, threshold_value,
		          duration_sec, quorum_min_probes, cooldown_sec, confirm_sec, recover_sec,
		          channel_ids, enabled, created_at
	`, id, in.Name, in.TargetID, in.GroupID, in.Metric, in.ThresholdValue,
		in.DurationSec, in.QuorumMinProbes, in.CooldownSec, in.ConfirmSec, in.RecoverSec,
		chJSON, in.Enabled).Scan(
		&r.ID, &r.Name, &r.TargetID, &r.GroupID, &r.Metric, &r.ThresholdValue,
		&r.DurationSec, &r.QuorumMinProbes, &r.CooldownSec, &r.ConfirmSec, &r.RecoverSec,
		&rawChannels, &r.Enabled, &r.CreatedAt,
	)
	r.ChannelIDs = decodeChannelIDs(rawChannels)
	return r, mapPGError(err)
}

func (s *Store) DeleteAlertRule(ctx context.Context, id uuid.UUID) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM alert_rules WHERE id = $1`, id)
	if err != nil {
		return mapPGError(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) ListAlertChannels(ctx context.Context) ([]AlertChannel, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, type, name, config_encrypted, config_hint, enabled, created_at
		FROM alert_channels
		ORDER BY created_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]AlertChannel, 0)
	for rows.Next() {
		var c AlertChannel
		if err := rows.Scan(&c.ID, &c.Type, &c.Name, &c.ConfigEncrypted, &c.ConfigHint, &c.Enabled, &c.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) GetAlertChannel(ctx context.Context, id uuid.UUID) (AlertChannel, error) {
	var c AlertChannel
	err := s.pool.QueryRow(ctx, `
		SELECT id, type, name, config_encrypted, config_hint, enabled, created_at
		FROM alert_channels WHERE id = $1
	`, id).Scan(&c.ID, &c.Type, &c.Name, &c.ConfigEncrypted, &c.ConfigHint, &c.Enabled, &c.CreatedAt)
	return c, mapPGError(err)
}

func (s *Store) CreateAlertChannel(ctx context.Context, typ, name string, enc []byte, hint string, enabled bool) (AlertChannel, error) {
	id := newUUIDv7()
	var c AlertChannel
	err := s.pool.QueryRow(ctx, `
		INSERT INTO alert_channels (id, type, name, config_encrypted, config_hint, enabled)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id, type, name, config_hint, enabled, created_at
	`, id, typ, name, enc, hint, enabled).Scan(&c.ID, &c.Type, &c.Name, &c.ConfigHint, &c.Enabled, &c.CreatedAt)
	return c, mapPGError(err)
}

func (s *Store) UpdateAlertChannel(ctx context.Context, id uuid.UUID, name string, enc []byte, hint string, enabled bool) (AlertChannel, error) {
	var c AlertChannel
	err := s.pool.QueryRow(ctx, `
		UPDATE alert_channels
		SET name = $2, config_encrypted = $3, config_hint = $4, enabled = $5
		WHERE id = $1
		RETURNING id, type, name, config_hint, enabled, created_at
	`, id, name, enc, hint, enabled).Scan(&c.ID, &c.Type, &c.Name, &c.ConfigHint, &c.Enabled, &c.CreatedAt)
	return c, mapPGError(err)
}

func (s *Store) DeleteAlertChannel(ctx context.Context, id uuid.UUID) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM alert_channels WHERE id = $1`, id)
	if err != nil {
		return mapPGError(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func scanIncidentRows(rows interface {
	Next() bool
	Scan(...any) error
	Err() error
}) ([]Incident, error) {
	out := make([]Incident, 0)
	for rows.Next() {
		var inc Incident
		var rawProbes []byte
		if err := rows.Scan(
			&inc.ID, &inc.RuleID, &inc.RuleName, &inc.TargetID, &inc.TargetName,
			&inc.Status, &inc.Severity, &rawProbes, &inc.PeakValue, &inc.StartedAt, &inc.ResolvedAt,
			&inc.LastNotifiedAt, &inc.Summary,
		); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(rawProbes, &inc.AffectedProbes); err != nil {
			inc.AffectedProbes = []string{}
		}
		out = append(out, inc)
	}
	return out, rows.Err()
}

func (s *Store) ListIncidents(ctx context.Context, limit int) ([]Incident, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	rows, err := s.pool.Query(ctx, `
		SELECT i.id, i.rule_id, COALESCE(r.name, 'Deleted Rule'), i.target_id,
		       COALESCE(t.name, 'Fleet / System'), i.status, i.severity, i.affected_probes,
		       i.peak_value, i.started_at, i.resolved_at, i.last_notified_at, i.summary
		FROM incidents i
		LEFT JOIN alert_rules r ON r.id = i.rule_id
		LEFT JOIN targets t ON t.id = i.target_id
		ORDER BY (i.status = 'open') DESC, i.started_at DESC
		LIMIT $1
	`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanIncidentRows(rows)
}

func (s *Store) ListOpenIncidents(ctx context.Context) ([]Incident, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT i.id, i.rule_id, COALESCE(r.name, 'Deleted Rule'), i.target_id,
		       COALESCE(t.name, 'Fleet / System'), i.status, i.severity, i.affected_probes,
		       i.peak_value, i.started_at, i.resolved_at, i.last_notified_at, i.summary
		FROM incidents i
		LEFT JOIN alert_rules r ON r.id = i.rule_id
		LEFT JOIN targets t ON t.id = i.target_id
		WHERE i.status = 'open'
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanIncidentRows(rows)
}

func (s *Store) CountOpenIncidents(ctx context.Context) (int, error) {
	var cnt int
	err := s.pool.QueryRow(ctx, `SELECT COUNT(*) FROM incidents WHERE status = 'open'`).Scan(&cnt)
	return cnt, err
}

func (s *Store) UpsertOpenIncident(ctx context.Context, ruleID uuid.UUID, targetID *uuid.UUID, affectedProbes []string, peak float64, severity string, now time.Time, summary string) (Incident, bool, bool, error) {
	if severity != "critical" {
		severity = "warn"
	}
	probesJSON, _ := json.Marshal(affectedProbes)

	var existing Incident
	var rawProbes []byte
	var err error
	if targetID != nil {
		err = s.pool.QueryRow(ctx, `
			SELECT id, rule_id, target_id, status, severity, affected_probes, peak_value, started_at, resolved_at, last_notified_at, summary
			FROM incidents WHERE rule_id = $1 AND target_id = $2 AND status = 'open'
		`, ruleID, *targetID).Scan(
			&existing.ID, &existing.RuleID, &existing.TargetID, &existing.Status, &existing.Severity, &rawProbes,
			&existing.PeakValue, &existing.StartedAt, &existing.ResolvedAt, &existing.LastNotifiedAt, &existing.Summary,
		)
	} else {
		err = s.pool.QueryRow(ctx, `
			SELECT id, rule_id, target_id, status, severity, affected_probes, peak_value, started_at, resolved_at, last_notified_at, summary
			FROM incidents WHERE rule_id = $1 AND target_id IS NULL AND status = 'open'
		`, ruleID).Scan(
			&existing.ID, &existing.RuleID, &existing.TargetID, &existing.Status, &existing.Severity, &rawProbes,
			&existing.PeakValue, &existing.StartedAt, &existing.ResolvedAt, &existing.LastNotifiedAt, &existing.Summary,
		)
	}

	if err == nil {
		if existing.Severity == "" {
			existing.Severity = "warn"
		}
		escalated := existing.Severity == "warn" && severity == "critical"
		nextSeverity := existing.Severity
		if severity == "critical" {
			nextSeverity = "critical"
		}
		if peak < existing.PeakValue {
			peak = existing.PeakValue
		}
		_, updErr := s.pool.Exec(ctx, `
			UPDATE incidents SET affected_probes = $2, peak_value = $3, summary = $4, severity = $5 WHERE id = $1
		`, existing.ID, probesJSON, peak, summary, nextSeverity)
		existing.AffectedProbes = affectedProbes
		existing.PeakValue = peak
		existing.Summary = summary
		existing.Severity = nextSeverity
		return existing, false, escalated, updErr
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Incident{}, false, false, err
	}

	id := newUUIDv7()
	err = s.pool.QueryRow(ctx, `
		INSERT INTO incidents (id, rule_id, target_id, status, severity, affected_probes, peak_value, started_at, summary)
		VALUES ($1, $2, $3, 'open', $4, $5, $6, $7, $8)
		RETURNING id, rule_id, target_id, status, severity, peak_value, started_at, resolved_at, last_notified_at, summary
	`, id, ruleID, targetID, severity, probesJSON, peak, now, summary).Scan(
		&existing.ID, &existing.RuleID, &existing.TargetID, &existing.Status, &existing.Severity,
		&existing.PeakValue, &existing.StartedAt, &existing.ResolvedAt, &existing.LastNotifiedAt, &existing.Summary,
	)
	if err != nil {
		return Incident{}, false, false, mapPGError(err)
	}
	existing.AffectedProbes = affectedProbes
	return existing, true, false, nil
}

func (s *Store) ResolveOpenIncident(ctx context.Context, ruleID uuid.UUID, targetID *uuid.UUID, now time.Time) (*Incident, error) {
	var inc Incident
	var rawProbes []byte
	var err error
	if targetID != nil {
		err = s.pool.QueryRow(ctx, `
			UPDATE incidents
			SET status = 'resolved', resolved_at = $3
			WHERE rule_id = $1 AND target_id = $2 AND status = 'open'
			RETURNING id, rule_id, target_id, status, severity, affected_probes, peak_value, started_at, resolved_at, last_notified_at, summary
		`, ruleID, *targetID, now).Scan(
			&inc.ID, &inc.RuleID, &inc.TargetID, &inc.Status, &inc.Severity, &rawProbes,
			&inc.PeakValue, &inc.StartedAt, &inc.ResolvedAt, &inc.LastNotifiedAt, &inc.Summary,
		)
	} else {
		err = s.pool.QueryRow(ctx, `
			UPDATE incidents
			SET status = 'resolved', resolved_at = $2
			WHERE rule_id = $1 AND target_id IS NULL AND status = 'open'
			RETURNING id, rule_id, target_id, status, severity, affected_probes, peak_value, started_at, resolved_at, last_notified_at, summary
		`, ruleID, now).Scan(
			&inc.ID, &inc.RuleID, &inc.TargetID, &inc.Status, &inc.Severity, &rawProbes,
			&inc.PeakValue, &inc.StartedAt, &inc.ResolvedAt, &inc.LastNotifiedAt, &inc.Summary,
		)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	_ = json.Unmarshal(rawProbes, &inc.AffectedProbes)
	return &inc, nil
}

func (s *Store) MarkIncidentNotified(ctx context.Context, id uuid.UUID, now time.Time) error {
	_, err := s.pool.Exec(ctx, `UPDATE incidents SET last_notified_at = $2 WHERE id = $1`, id, now)
	return err
}

// --- Settings & Retention ---

func (s *Store) GetSettings(ctx context.Context) (SystemSettings, error) {
	var st SystemSettings
	err := s.pool.QueryRow(ctx, `
		SELECT raw_retention_days, agg_retention_days, default_quorum_min, COALESCE(brand_name, ''), updated_at
		FROM system_settings WHERE id = 1
	`).Scan(&st.RawRetentionDays, &st.AggRetentionDays, &st.DefaultQuorumMin, &st.BrandName, &st.UpdatedAt)
	return st, mapPGError(err)
}

func (s *Store) UpdateSettingsAndRetention(ctx context.Context, rawDays, aggDays, defaultQuorum int, brandName string) (SystemSettings, error) {
	var st SystemSettings
	err := s.pool.QueryRow(ctx, `
		UPDATE system_settings
		SET raw_retention_days = $1, agg_retention_days = $2, default_quorum_min = $3, brand_name = $4, updated_at = NOW()
		WHERE id = 1
		RETURNING raw_retention_days, agg_retention_days, default_quorum_min, COALESCE(brand_name, ''), updated_at
	`, rawDays, aggDays, defaultQuorum, brandName).Scan(&st.RawRetentionDays, &st.AggRetentionDays, &st.DefaultQuorumMin, &st.BrandName, &st.UpdatedAt)
	if err != nil {
		return st, mapPGError(err)
	}

	rawInterval := fmt.Sprintf("%d days", rawDays)
	aggInterval := fmt.Sprintf("%d days", aggDays)

	policies := []struct {
		relation string
		interval string
	}{
		{"ping_samples", rawInterval},
		{"agg_1m", aggInterval},
		{"agg_5m", aggInterval},
		{"agg_1h", aggInterval},
	}

	for _, p := range policies {
		if _, err := s.pool.Exec(ctx, `SELECT remove_retention_policy($1, if_exists => TRUE)`, p.relation); err != nil {
			return st, fmt.Errorf("remove retention %s: %w", p.relation, err)
		}
		if _, err := s.pool.Exec(ctx, `SELECT add_retention_policy($1, $2::interval, if_not_exists => TRUE)`, p.relation, p.interval); err != nil {
			return st, fmt.Errorf("add retention %s: %w", p.relation, err)
		}
	}

	return st, nil
}
