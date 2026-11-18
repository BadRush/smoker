package protocol

import "encoding/json"

const (
	// Probe -> Central frames
	MsgHello           = "hello"
	MsgClockPing       = "clock_ping"
	MsgSamplesLive     = "samples_live"
	MsgSamplesBackfill = "samples_backfill"
	MsgHeartbeat       = "heartbeat"
	MsgMTRResult       = "mtr_result"

	// Central -> Probe frames
	MsgWelcome    = "welcome"
	MsgClockPong  = "clock_pong"
	MsgConfigSync = "config_sync"
	MsgAck        = "ack"
	MsgRunMTR     = "run_mtr"
)

// Envelope is the top-level JSON frame exchanged over /ws/probe.
type Envelope struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

type HelloPayload struct {
	AgentVersion string `json:"agent_version"`
	Hostname     string `json:"hostname"`
}

type WelcomePayload struct {
	ProbeID    string `json:"probe_id"`
	ProbeName  string `json:"probe_name"`
	ServerTime int64  `json:"server_time_ns"`
}

type ClockPingPayload struct {
	Seq int64 `json:"seq"`
	T1  int64 `json:"t1_ns"`
}

type ClockPongPayload struct {
	Seq int64 `json:"seq"`
	T1  int64 `json:"t1_ns"`
	T2  int64 `json:"t2_ns"`
	T3  int64 `json:"t3_ns"`
}

type TargetConfig struct {
	ID               string `json:"id"`
	Name             string `json:"name"`
	Host             string `json:"host"`
	ProbeType        string `json:"probe_type"` // icmp | tcp | http | dns
	PortOrPath       string `json:"port_or_path"`
	IntervalSec      int    `json:"interval_sec"`
	TimeoutMs        int    `json:"timeout_ms"`
	AutoMTROnLoss    bool   `json:"auto_mtr_on_loss"`
	MTRLossThreshold int    `json:"mtr_loss_threshold"`
	LatencyWarnMs    int    `json:"latency_warn_ms,omitempty"`
}

type ConfigSyncPayload struct {
	ConfigVersion int64          `json:"config_version"`
	Targets       []TargetConfig `json:"targets"`
}

type SampleRecord struct {
	TimestampNs int64  `json:"ts_ns"`
	TargetID    string `json:"target_id"`
	RTTUs       *int32 `json:"rtt_us,omitempty"`
	JitterUs    int32  `json:"jitter_us"`
	IsLoss      bool   `json:"is_loss"`
}

type SamplesBatchPayload struct {
	BatchID        string         `json:"batch_id"`
	BacklogCount   int64          `json:"backlog_count"`
	ClockOffsetMs  float64        `json:"clock_offset_ms"`
	Samples        []SampleRecord `json:"samples"`
}

type AckPayload struct {
	BatchID string `json:"batch_id"`
	Kind    string `json:"kind"` // live | backfill | mtr
	Count   int    `json:"count"`
}

type HeartbeatPayload struct {
	PendingBacklog int64   `json:"pending_backlog_count"`
	ClockOffsetMs  float64 `json:"clock_offset_ms"`
	AgentVersion   string  `json:"agent_version"`
}

type RunMTRPayload struct {
	RequestID string `json:"request_id"`
	TargetID  string `json:"target_id"`
	Host      string `json:"host"`
	ProbeType string `json:"probe_type,omitempty"`
}

type MTRHop struct {
	Hop     int     `json:"hop"`
	IP      string  `json:"ip"`
	Host    string  `json:"host,omitempty"`
	Sent    int     `json:"sent"`
	Recv    int     `json:"recv"`
	LossPct float64 `json:"loss_pct"`
	BestUs  int32   `json:"best_us"`
	AvgUs   int32   `json:"avg_us"`
	WorstUs int32   `json:"worst_us"`
	StDevUs int32   `json:"stdev_us"`
}

type MTRResultPayload struct {
	BatchID       string   `json:"batch_id,omitempty"`
	RequestID     string   `json:"request_id,omitempty"`
	TargetID      string   `json:"target_id"`
	CapturedAtNs  int64    `json:"captured_at_ns"`
	TriggerReason string   `json:"trigger_reason"` // auto_loss | manual
	Hops          []MTRHop `json:"hops"`
	Error         string   `json:"error,omitempty"`
}

// UI Live WebSocket frames (/ws/live)
type LiveSubscribe struct {
	Channel string `json:"channel"` // "matrix" or "target:<uuid>"
}

type LiveEvent struct {
	Type    string `json:"type"` // sample_tick | probe_status | mtr_ready | incident_update
	Channel string `json:"channel"`
	Data    any    `json:"data"`
}
