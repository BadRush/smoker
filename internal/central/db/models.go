package db

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"smoker/internal/protocol"
)

var (
	ErrNotFound     = errors.New("resource not found")
	ErrConflict     = errors.New("resource conflict")
	ErrInvalidInput = errors.New("invalid input")
)

type ProbeInUseError struct {
	TargetNames []string
}

func (e *ProbeInUseError) Error() string {
	return fmt.Sprintf("probe is the sole assigned probe for active target(s): %s", strings.Join(e.TargetNames, ", "))
}

func (e *ProbeInUseError) Unwrap() error {
	return ErrConflict
}

type AdminUser struct {
	Username     string
	PasswordHash string
	UpdatedAt    time.Time
}

type Probe struct {
	ID                  uuid.UUID  `json:"id"`
	Name                string     `json:"name"`
	LocationLabel       string     `json:"location_label"`
	ISPAsn              string     `json:"isp_asn"`
	IsLocal             bool       `json:"is_local"`
	Status              string     `json:"status"`
	PendingBacklogCount int64      `json:"pending_backlog_count"`
	ClockOffsetMs       float64    `json:"clock_offset_ms"`
	LastSeenAt          *time.Time `json:"last_seen_at"`
	AgentVersion        string     `json:"agent_version"`
	CreatedAt           time.Time  `json:"created_at"`
}

type TargetGroup struct {
	ID          uuid.UUID  `json:"id"`
	Name        string     `json:"name"`
	ParentID    *uuid.UUID `json:"parent_id"`
	Description string     `json:"description"`
	SortOrder   int        `json:"sort_order"`
	CreatedAt   time.Time  `json:"created_at"`
}

type Target struct {
	ID                    uuid.UUID      `json:"id"`
	GroupID               *uuid.UUID     `json:"group_id"`
	Name                  string         `json:"name"`
	Host                  string         `json:"host"`
	ProbeType             string         `json:"probe_type"`
	PortOrPath            string         `json:"port_or_path"`
	IntervalSec           int            `json:"interval_sec"`
	TimeoutMs             int            `json:"timeout_ms"`
	Enabled               bool           `json:"enabled"`
	AutoMTROnLoss         bool           `json:"auto_mtr_on_loss"`
	MTRLossThreshold      int            `json:"mtr_loss_threshold"`
	AssignAllProbes       bool           `json:"assign_all_probes"`
	ProbeIDs              []uuid.UUID    `json:"probe_ids"`
	PinnedOnTV            bool           `json:"pinned_on_tv"`
	LatencyWarnMs         int            `json:"latency_warn_ms"`
	ProbeLatencyOverrides map[string]int `json:"probe_latency_overrides"`
	CreatedAt             time.Time      `json:"created_at"`
	UpdatedAt             time.Time      `json:"updated_at"`
}

type AlertRule struct {
	ID              uuid.UUID   `json:"id"`
	Name            string      `json:"name"`
	TargetID        *uuid.UUID  `json:"target_id"`
	GroupID         *uuid.UUID  `json:"group_id"`
	Metric          string      `json:"metric"`
	ThresholdValue  float64     `json:"threshold_value"`
	DurationSec     int         `json:"duration_sec"`
	QuorumMinProbes int         `json:"quorum_min_probes"`
	CooldownSec     int         `json:"cooldown_sec"`
	ConfirmSec      int         `json:"confirm_sec"`
	RecoverSec      int         `json:"recover_sec"`
	ChannelIDs      []uuid.UUID `json:"channel_ids"`
	Enabled         bool        `json:"enabled"`
	CreatedAt       time.Time   `json:"created_at"`
}

type AlertChannel struct {
	ID              uuid.UUID `json:"id"`
	Type            string    `json:"type"`
	Name            string    `json:"name"`
	ConfigEncrypted []byte    `json:"-"`
	ConfigHint      string    `json:"config_hint"`
	Enabled         bool      `json:"enabled"`
	CreatedAt       time.Time `json:"created_at"`
}

type Incident struct {
	ID             uuid.UUID  `json:"id"`
	RuleID         uuid.UUID  `json:"rule_id"`
	RuleName       string     `json:"rule_name"`
	TargetID       *uuid.UUID `json:"target_id"`
	TargetName     string     `json:"target_name"`
	Status         string     `json:"status"`
	Severity       string     `json:"severity"`
	AffectedProbes []string   `json:"affected_probes"`
	PeakValue      float64    `json:"peak_value"`
	StartedAt      time.Time  `json:"started_at"`
	ResolvedAt     *time.Time `json:"resolved_at"`
	LastNotifiedAt *time.Time `json:"-"`
	Summary        string     `json:"summary"`
}

type MTRSnapshot struct {
	ID            uuid.UUID         `json:"id"`
	ProbeID       uuid.UUID         `json:"probe_id"`
	ProbeName     string            `json:"probe_name"`
	TargetID      uuid.UUID         `json:"target_id"`
	CapturedAt    time.Time         `json:"captured_at"`
	TriggerReason string            `json:"trigger_reason"`
	Hops          []protocol.MTRHop `json:"hops"`
}

type SystemSettings struct {
	RawRetentionDays int       `json:"raw_retention_days"`
	AggRetentionDays int       `json:"agg_retention_days"`
	DefaultQuorumMin int       `json:"default_quorum_min"`
	UpdatedAt        time.Time `json:"updated_at"`
}

type ProbeSeries struct {
	ProbeID       uuid.UUID  `json:"probe_id"`
	ProbeName     string     `json:"probe_name"`
	LocationLabel string     `json:"location_label"`
	BaselineMs    *float64   `json:"baseline_ms,omitempty"`
	WarnMs        *float64   `json:"warn_ms,omitempty"`
	Timestamps    []int64    `json:"timestamps"`
	MinMs         []*float64 `json:"min_ms"`
	P25Ms         []*float64 `json:"p25_ms"`
	P50Ms         []*float64 `json:"p50_ms"`
	P75Ms         []*float64 `json:"p75_ms"`
	P95Ms         []*float64 `json:"p95_ms"`
	MaxMs         []*float64 `json:"max_ms"`
	JitterMs      []*float64 `json:"jitter_ms"`
	LossPct       []float64  `json:"loss_pct"`
}

type TargetSeriesResponse struct {
	Target    Target        `json:"target"`
	Range     string        `json:"range"`
	BucketSec int           `json:"bucket_sec"`
	Series    []ProbeSeries `json:"series"`
}

type BatchSeriesResponse struct {
	Range     string                   `json:"range"`
	BucketSec int                      `json:"bucket_sec"`
	Targets   map[string][]ProbeSeries `json:"targets"`
}
