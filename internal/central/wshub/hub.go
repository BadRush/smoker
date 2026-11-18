package wshub

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"smoker/internal/central/auth"
	"smoker/internal/central/db"
	"smoker/internal/central/ingest"
	"smoker/internal/protocol"
)

type probeConn struct {
	metaMu sync.RWMutex
	probe  db.Probe
	conn   *websocket.Conn
	send   chan []byte
}

func (pc *probeConn) probeName() string {
	pc.metaMu.RLock()
	defer pc.metaMu.RUnlock()
	return pc.probe.Name
}

func (pc *probeConn) setProbeMeta(name, locationLabel, ispASN string) {
	pc.metaMu.Lock()
	pc.probe.Name = name
	pc.probe.LocationLabel = locationLabel
	pc.probe.ISPAsn = ispASN
	pc.metaMu.Unlock()
}

type uiClient struct {
	conn *websocket.Conn
	send chan []byte
	mu   sync.RWMutex
	subs map[string]bool
}

type Hub struct {
	store            *db.Store
	ingestor         *ingest.Ingestor
	jwtSecret        string
	nocTVAllowUnauth bool

	mu         sync.RWMutex
	probes     map[uuid.UUID]*probeConn
	uiClients  map[*uiClient]struct{}
	configVer  atomic.Int64
}

func NewHub(store *db.Store, ingestor *ingest.Ingestor, jwtSecret string) *Hub {
	h := &Hub{
		store:     store,
		ingestor:  ingestor,
		jwtSecret: jwtSecret,
		probes:    make(map[uuid.UUID]*probeConn),
		uiClients: make(map[*uiClient]struct{}),
	}
	h.configVer.Store(time.Now().UnixMilli())
	return h
}

func (h *Hub) SetNocTVAllowUnauth(allow bool) {
	h.nocTVAllowUnauth = allow
}

func (h *Hub) RunStalenessMonitor(ctx context.Context) {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			cutoff := time.Now().UTC().Add(-35 * time.Second)
			staleIDs, err := h.store.MarkStaleProbesOffline(ctx, cutoff)
			if err != nil {
				slog.Warn("mark stale probes failed", "err", err)
				continue
			}
			for _, pid := range staleIDs {
				h.BroadcastUI("matrix", protocol.LiveEvent{
					Type:    "probe_status",
					Channel: "matrix",
					Data: map[string]any{
						"probe_id": pid.String(),
						"status":   "offline",
					},
				})
			}
		}
	}
}

// HandleProbeWS upgrades incoming probe agent connections (/ws/probe).
func (h *Hub) HandleProbeWS(w http.ResponseWriter, r *http.Request) {
	token := extractBearer(r.Header.Get("Authorization"))
	if token == "" {
		token = strings.TrimSpace(r.Header.Get("X-Probe-Token"))
	}
	if token == "" {
		http.Error(w, "missing probe token", http.StatusUnauthorized)
		return
	}

	probe, err := h.store.GetProbeByTokenHash(r.Context(), auth.HashProbeToken(token))
	if err != nil {
		http.Error(w, "invalid probe token", http.StatusUnauthorized)
		return
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true, // Gateway handles Origin/Host validation
	})
	if err != nil {
		slog.Warn("probe ws accept failed", "err", err)
		return
	}
	conn.SetReadLimit(8 << 20) // 8 MB for backfill chunks

	pc := &probeConn{
		probe: probe,
		conn:  conn,
		send:  make(chan []byte, 64),
	}

	h.registerProbe(pc)
	defer h.unregisterProbe(pc)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	// Send initial welcome + config_sync
	_ = h.sendFrame(pc, protocol.MsgWelcome, protocol.WelcomePayload{
		ProbeID:    probe.ID.String(),
		ProbeName:  probe.Name,
		ServerTime: time.Now().UTC().UnixNano(),
	})
	_ = h.SyncProbeConfig(ctx, probe.ID)

	go func() {
		defer cancel()
		for {
			select {
			case <-ctx.Done():
				return
			case msg := <-pc.send:
				writeCtx, wCancel := context.WithTimeout(ctx, 10*time.Second)
				err := conn.Write(writeCtx, websocket.MessageText, msg)
				wCancel()
				if err != nil {
					return
				}
			}
		}
	}()

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		var env protocol.Envelope
		if err := json.Unmarshal(data, &env); err != nil {
			continue
		}
		h.handleProbeMessage(ctx, pc, env)
	}
}

func (h *Hub) registerProbe(pc *probeConn) {
	h.mu.Lock()
	if old, ok := h.probes[pc.probe.ID]; ok {
		_ = old.conn.Close(websocket.StatusNormalClosure, "replaced by new connection")
	}
	h.probes[pc.probe.ID] = pc
	h.mu.Unlock()

	_ = h.store.UpdateProbePresence(context.Background(), pc.probe.ID, "online", pc.probe.PendingBacklogCount, pc.probe.ClockOffsetMs, pc.probe.AgentVersion, time.Now().UTC())
	h.BroadcastUI("matrix", protocol.LiveEvent{
		Type:    "probe_status",
		Channel: "matrix",
		Data: map[string]any{
			"probe_id": pc.probe.ID.String(),
			"status":   "online",
		},
	})
}

func (h *Hub) unregisterProbe(pc *probeConn) {
	h.mu.Lock()
	cur, ok := h.probes[pc.probe.ID]
	isSame := ok && cur == pc
	if isSame {
		delete(h.probes, pc.probe.ID)
	}
	h.mu.Unlock()

	_ = pc.conn.Close(websocket.StatusNormalClosure, "disconnect")
	if isSame {
		_ = h.store.UpdateProbePresence(context.Background(), pc.probe.ID, "offline", pc.probe.PendingBacklogCount, pc.probe.ClockOffsetMs, pc.probe.AgentVersion, time.Now().UTC())
		h.BroadcastUI("matrix", protocol.LiveEvent{
			Type:    "probe_status",
			Channel: "matrix",
			Data: map[string]any{
				"probe_id": pc.probe.ID.String(),
				"status":   "offline",
			},
		})
	}
}

func (h *Hub) handleProbeMessage(ctx context.Context, pc *probeConn, env protocol.Envelope) {
	now := time.Now().UTC()
	switch env.Type {
	case protocol.MsgHello:
		var p protocol.HelloPayload
		if json.Unmarshal(env.Payload, &p) == nil {
			pc.probe.AgentVersion = p.AgentVersion
			_ = h.store.UpdateProbePresence(ctx, pc.probe.ID, "online", pc.probe.PendingBacklogCount, pc.probe.ClockOffsetMs, p.AgentVersion, now)
		}

	case protocol.MsgClockPing:
		var p protocol.ClockPingPayload
		if json.Unmarshal(env.Payload, &p) == nil {
			t2 := time.Now().UTC().UnixNano()
			_ = h.sendFrame(pc, protocol.MsgClockPong, protocol.ClockPongPayload{
				Seq: p.Seq,
				T1:  p.T1,
				T2:  t2,
				T3:  time.Now().UTC().UnixNano(),
			})
		}

	case protocol.MsgSamplesLive, protocol.MsgSamplesBackfill:
		var batch protocol.SamplesBatchPayload
		if err := json.Unmarshal(env.Payload, &batch); err != nil {
			return
		}
		isBackfill := env.Type == protocol.MsgSamplesBackfill
		cnt, err := h.ingestor.IngestBatch(ctx, pc.probe.ID, isBackfill, batch.Samples)
		if err != nil {
			slog.Error("ingest batch failed", "probe_id", pc.probe.ID, "backfill", isBackfill, "err", err)
			return
		}

		status := "online"
		if batch.BacklogCount > 0 {
			status = "syncing"
		}
		pc.probe.PendingBacklogCount = batch.BacklogCount
		pc.probe.ClockOffsetMs = batch.ClockOffsetMs
		_ = h.store.UpdateProbePresence(ctx, pc.probe.ID, status, batch.BacklogCount, batch.ClockOffsetMs, pc.probe.AgentVersion, now)

		kind := "live"
		if isBackfill {
			kind = "backfill"
		}
		_ = h.sendFrame(pc, protocol.MsgAck, protocol.AckPayload{
			BatchID: batch.BatchID,
			Kind:    kind,
			Count:   cnt,
		})

		if !isBackfill && len(batch.Samples) > 0 {
			h.BroadcastUI("matrix", protocol.LiveEvent{
				Type:    "sample_tick",
				Channel: "matrix",
				Data: map[string]any{
					"probe_id":      pc.probe.ID.String(),
					"status":        status,
					"backlog_count": batch.BacklogCount,
					"samples":       batch.Samples,
				},
			})
			// Fan out to per-target subscribers
			byTarget := make(map[string][]protocol.SampleRecord)
			for _, s := range batch.Samples {
				byTarget[s.TargetID] = append(byTarget[s.TargetID], s)
			}
			for tid, recs := range byTarget {
				ch := "target:" + tid
				h.BroadcastUI(ch, protocol.LiveEvent{
					Type:    "sample_tick",
					Channel: ch,
					Data: map[string]any{
						"probe_id": pc.probe.ID.String(),
						"samples":  recs,
					},
				})
			}
		}

	case protocol.MsgHeartbeat:
		var hb protocol.HeartbeatPayload
		if json.Unmarshal(env.Payload, &hb) == nil {
			status := "online"
			if hb.PendingBacklog > 0 {
				status = "syncing"
			}
			pc.probe.PendingBacklogCount = hb.PendingBacklog
			pc.probe.ClockOffsetMs = hb.ClockOffsetMs
			if hb.AgentVersion != "" {
				pc.probe.AgentVersion = hb.AgentVersion
			}
			_ = h.store.UpdateProbePresence(ctx, pc.probe.ID, status, hb.PendingBacklog, hb.ClockOffsetMs, pc.probe.AgentVersion, now)
			h.BroadcastUI("matrix", protocol.LiveEvent{
				Type:    "probe_status",
				Channel: "matrix",
				Data: map[string]any{
					"probe_id":        pc.probe.ID.String(),
					"status":          status,
					"backlog_count":   hb.PendingBacklog,
					"clock_offset_ms": hb.ClockOffsetMs,
				},
			})
		}

	case protocol.MsgMTRResult:
		var mtr protocol.MTRResultPayload
		if err := json.Unmarshal(env.Payload, &mtr); err != nil {
			return
		}
		if mtr.BatchID != "" {
			_ = h.sendFrame(pc, protocol.MsgAck, protocol.AckPayload{
				BatchID: mtr.BatchID,
				Kind:    "mtr",
				Count:   1,
			})
		}
		tid, err := uuid.Parse(mtr.TargetID)
		if err != nil {
			return
		}
		reason := mtr.TriggerReason
		if reason != "manual" && reason != "auto_latency" {
			reason = "auto_loss"
		}
		ch := "target:" + tid.String()
		if len(mtr.Hops) == 0 {
			errMsg := mtr.Error
			if errMsg == "" {
				errMsg = "No MTR hops captured"
			}
			slog.Warn("mtr completed with empty hops", "probe_id", pc.probe.ID, "target_id", tid, "err", errMsg)
			h.BroadcastUI(ch, protocol.LiveEvent{
				Type:    "mtr_ready",
				Channel: ch,
				Data: map[string]any{
					"target_id":      tid,
					"probe_id":       pc.probe.ID,
					"probe_name":     pc.probeName(),
					"trigger_reason": reason,
					"error":          errMsg,
				},
			})
			return
		}
		capturedAt := time.Unix(0, mtr.CapturedAtNs).UTC()
		if mtr.CapturedAtNs <= 0 {
			capturedAt = now
		}
		snap, err := h.store.InsertMTRSnapshot(ctx, pc.probe.ID, tid, capturedAt, reason, mtr.Hops)
		if err != nil {
			slog.Error("insert mtr snapshot failed", "err", err)
			return
		}
		snap.ProbeName = pc.probeName()
		h.BroadcastUI(ch, protocol.LiveEvent{
			Type:    "mtr_ready",
			Channel: ch,
			Data:    snap,
		})
	}
}

func (h *Hub) SyncProbeConfig(ctx context.Context, probeID uuid.UUID) error {
	h.mu.RLock()
	pc, ok := h.probes[probeID]
	h.mu.RUnlock()
	if !ok {
		return nil
	}
	targets, err := h.store.TargetsForProbe(ctx, probeID)
	if err != nil {
		return err
	}
	ver := h.configVer.Add(1)
	return h.sendFrame(pc, protocol.MsgConfigSync, protocol.ConfigSyncPayload{
		ConfigVersion: ver,
		Targets:       targets,
	})
}

func (h *Hub) SyncAllProbes(ctx context.Context) {
	h.mu.RLock()
	ids := make([]uuid.UUID, 0, len(h.probes))
	for id := range h.probes {
		ids = append(ids, id)
	}
	h.mu.RUnlock()

	for _, id := range ids {
		if err := h.SyncProbeConfig(ctx, id); err != nil {
			slog.Warn("sync probe config failed", "probe_id", id, "err", err)
		}
	}
}

// UpdateProbeMeta updates cached probe metadata on active WS sessions and notifies connected UI clients.
func (h *Hub) UpdateProbeMeta(probe db.Probe) {
	h.mu.RLock()
	pc, ok := h.probes[probe.ID]
	h.mu.RUnlock()
	if ok {
		pc.setProbeMeta(probe.Name, probe.LocationLabel, probe.ISPAsn)
	}

	h.BroadcastUI("matrix", protocol.LiveEvent{
		Type:    "probe_status",
		Channel: "matrix",
		Data: map[string]any{
			"probe_id":       probe.ID.String(),
			"probe_name":     probe.Name,
			"location_label": probe.LocationLabel,
			"isp_asn":        probe.ISPAsn,
			"status":         probe.Status,
		},
	})
}

func (h *Hub) SendRunMTR(ctx context.Context, target db.Target, optionalProbeID *uuid.UUID) ([]string, error) {
	h.mu.RLock()
	var targets []*probeConn
	if optionalProbeID != nil {
		if pc, ok := h.probes[*optionalProbeID]; ok {
			targets = append(targets, pc)
		}
	} else {
		assigned := make(map[uuid.UUID]bool, len(target.ProbeIDs))
		for _, pid := range target.ProbeIDs {
			assigned[pid] = true
		}
		for pid, pc := range h.probes {
			if target.AssignAllProbes || assigned[pid] {
				targets = append(targets, pc)
			}
		}
	}
	h.mu.RUnlock()

	reqIDs := make([]string, 0, len(targets))
	for _, pc := range targets {
		reqID := uuid.NewString()
		if err := h.sendFrame(pc, protocol.MsgRunMTR, protocol.RunMTRPayload{
			RequestID: reqID,
			TargetID:  target.ID.String(),
			Host:      target.Host,
			ProbeType: target.ProbeType,
		}); err == nil {
			reqIDs = append(reqIDs, reqID)
		}
	}
	return reqIDs, nil
}

func (h *Hub) sendFrame(pc *probeConn, msgType string, payload any) error {
	rawPayload, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	frame, err := json.Marshal(protocol.Envelope{
		Type:    msgType,
		Payload: rawPayload,
	})
	if err != nil {
		return err
	}
	select {
	case pc.send <- frame:
		return nil
	default:
		return context.DeadlineExceeded
	}
}

// HandleLiveWS serves authenticated browser subscribers (/ws/live) and optional read-only TV wallboards (/ws/live?scope=tv).
func (h *Hub) HandleLiveWS(w http.ResponseWriter, r *http.Request) {
	isTVScope := r.URL.Query().Get("scope") == "tv"
	authenticated := false
	if cookie, err := r.Cookie(auth.SessionCookieName); err == nil {
		if _, err := auth.VerifySessionToken(h.jwtSecret, cookie.Value); err == nil {
			authenticated = true
		}
	}
	if !authenticated && !(isTVScope && h.nocTVAllowUnauth) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
	})
	if err != nil {
		return
	}

	client := &uiClient{
		conn: conn,
		send: make(chan []byte, 64),
		subs: map[string]bool{"matrix": true},
	}

	h.mu.Lock()
	h.uiClients[client] = struct{}{}
	h.mu.Unlock()

	defer func() {
		h.mu.Lock()
		delete(h.uiClients, client)
		h.mu.Unlock()
		_ = conn.Close(websocket.StatusNormalClosure, "bye")
	}()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	go func() {
		defer cancel()
		for {
			select {
			case <-ctx.Done():
				return
			case msg := <-client.send:
				wCtx, wCancel := context.WithTimeout(ctx, 5*time.Second)
				err := conn.Write(wCtx, websocket.MessageText, msg)
				wCancel()
				if err != nil {
					return
				}
			}
		}
	}()

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		var sub protocol.LiveSubscribe
		if json.Unmarshal(data, &sub) == nil && sub.Channel != "" {
			if !authenticated && sub.Channel != "matrix" && !strings.HasPrefix(sub.Channel, "target:") {
				continue
			}
			client.mu.Lock()
			client.subs[sub.Channel] = true
			client.mu.Unlock()
		}
	}
}

func (h *Hub) BroadcastUI(channel string, event protocol.LiveEvent) {
	raw, err := json.Marshal(event)
	if err != nil {
		return
	}

	h.mu.RLock()
	clients := make([]*uiClient, 0, len(h.uiClients))
	for c := range h.uiClients {
		clients = append(clients, c)
	}
	h.mu.RUnlock()

	for _, c := range clients {
		c.mu.RLock()
		subscribed := c.subs[channel]
		c.mu.RUnlock()
		if !subscribed {
			continue
		}
		select {
		case c.send <- raw:
		default:
		}
	}
}

func extractBearer(header string) string {
	if !strings.HasPrefix(strings.ToLower(header), "bearer ") {
		return ""
	}
	return strings.TrimSpace(header[7:])
}
