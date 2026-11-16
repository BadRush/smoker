package uplink

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"smoker/internal/probe/buffer"
	"smoker/internal/probe/clock"
	"smoker/internal/probe/config"
	"smoker/internal/probe/engine"
	"smoker/internal/protocol"
)

type Client struct {
	cfg       config.ProbeConfig
	buf       *buffer.SQLiteBuffer
	clk       *clock.Tracker
	scheduler *engine.Scheduler

	liveCh chan protocol.SampleRecord
	mtrCh  chan protocol.MTRResultPayload

	connMu   sync.RWMutex
	conn     *websocket.Conn
	writeMu  sync.Mutex
	pingSeq  atomic.Int64
	pingSend sync.Map // int64 -> int64 (t1Ns)
	ackWait  sync.Map // batchID -> chan struct{}
}

func NewClient(cfg config.ProbeConfig, buf *buffer.SQLiteBuffer, clk *clock.Tracker) *Client {
	return &Client{
		cfg:    cfg,
		buf:    buf,
		clk:    clk,
		liveCh: make(chan protocol.SampleRecord, 4096),
		mtrCh:  make(chan protocol.MTRResultPayload, 64),
	}
}

func (c *Client) SetScheduler(s *engine.Scheduler) {
	c.scheduler = s
}

func (c *Client) EnqueueSample(rec protocol.SampleRecord) {
	select {
	case c.liveCh <- rec:
	default:
		// If channel is full under extreme load, persist single sample immediately
		_ = c.buf.EnqueueSamples(context.Background(), []protocol.SampleRecord{rec})
	}
}

func (c *Client) TriggerAutoMTR(targetID, host, probeType string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()

	hops, err := engine.RunMTRWithFamily(ctx, host, strings.HasSuffix(probeType, "6"))
	if err != nil {
		slog.Warn("auto mtr failed", "target_id", targetID, "host", host, "err", err)
		return err
	}
	if hops == nil {
		hops = []protocol.MTRHop{}
	}
	res := protocol.MTRResultPayload{
		BatchID:       uuid.NewString(),
		TargetID:      targetID,
		CapturedAtNs:  c.clk.AdjustedNowUnixNs(),
		TriggerReason: "auto_loss",
		Hops:          hops,
	}
	select {
	case c.mtrCh <- res:
	default:
		_ = c.buf.EnqueueMTR(context.Background(), res)
	}
	return nil
}

func (c *Client) Run(ctx context.Context) {
	go c.batchFlusherLoop(ctx)
	go c.mtrLoop(ctx)
	go c.backfillLoop(ctx)
	go c.retentionLoop(ctx)

	backoff := time.Second
	for {
		if ctx.Err() != nil {
			return
		}
		err := c.connectAndServe(ctx)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			slog.Warn("uplink disconnected", "err", err, "retry_in", backoff.String())
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff *= 2
		if backoff > 30*time.Second {
			backoff = 30 * time.Second
		}
	}
}

func (c *Client) connectAndServe(parentCtx context.Context) error {
	dialCtx, cancel := context.WithTimeout(parentCtx, 10*time.Second)
	defer cancel()

	headers := http.Header{}
	headers.Set("Authorization", "Bearer "+c.cfg.ProbeToken)

	dialOpts := &websocket.DialOptions{
		HTTPHeader: headers,
	}
	if c.cfg.TLSSkipVerify {
		tr := http.DefaultTransport.(*http.Transport).Clone()
		tr.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} // #nosec G402 -- explicit opt-in for private internal TLS
		dialOpts.HTTPClient = &http.Client{Transport: tr}
	}

	conn, resp, err := websocket.Dial(dialCtx, c.cfg.CentralURL, dialOpts)
	if err != nil {
		if resp != nil {
			slog.Warn("uplink ws handshake rejected", "status", resp.StatusCode, "url", c.cfg.CentralURL)
		}
		return err
	}
	conn.SetReadLimit(8 << 20)

	c.setConn(conn)
	defer func() {
		c.clearConn(conn)
		_ = conn.Close(websocket.StatusNormalClosure, "bye")
	}()

	slog.Info("connected to smoker central", "url", c.cfg.CentralURL)

	hostname, _ := os.Hostname()
	_ = c.writeFrame(parentCtx, conn, protocol.MsgHello, protocol.HelloPayload{
		AgentVersion: c.cfg.AgentVersion,
		Hostname:     hostname,
	})
	c.sendClockPing(parentCtx, conn)

	subCtx, cancelSub := context.WithCancel(parentCtx)
	defer cancelSub()

	go func() {
		hbTicker := time.NewTicker(10 * time.Second)
		pingTicker := time.NewTicker(20 * time.Second)
		clkTicker := time.NewTicker(30 * time.Second)
		defer hbTicker.Stop()
		defer pingTicker.Stop()
		defer clkTicker.Stop()

		for {
			select {
			case <-subCtx.Done():
				return
			case <-pingTicker.C:
				pCtx, pCancel := context.WithTimeout(subCtx, 8*time.Second)
				pErr := conn.Ping(pCtx)
				pCancel()
				if pErr != nil {
					slog.Warn("uplink websocket keepalive failed", "err", pErr)
					cancelSub()
					return
				}
			case <-clkTicker.C:
				c.sendClockPing(subCtx, conn)
			case <-hbTicker.C:
				backlog, _ := c.buf.CountSamples(subCtx)
				if err := c.writeFrame(subCtx, conn, protocol.MsgHeartbeat, protocol.HeartbeatPayload{
					PendingBacklog: backlog,
					ClockOffsetMs:  c.clk.OffsetMs(),
					AgentVersion:   c.cfg.AgentVersion,
				}); err != nil {
					cancelSub()
					return
				}
			}
		}
	}()

	for {
		_, data, err := conn.Read(subCtx)
		if err != nil {
			return err
		}
		var env protocol.Envelope
		if err := json.Unmarshal(data, &env); err != nil {
			continue
		}
		c.handleCentralMessage(parentCtx, env)
	}
}

func (c *Client) handleCentralMessage(ctx context.Context, env protocol.Envelope) {
	switch env.Type {
	case protocol.MsgClockPong:
		var p protocol.ClockPongPayload
		if json.Unmarshal(env.Payload, &p) == nil {
			t4 := time.Now().UTC().UnixNano()
			if t1Val, ok := c.pingSend.LoadAndDelete(p.Seq); ok {
				t1 := t1Val.(int64)
				c.clk.Record(t1, p.T2, p.T3, t4)
			}
		}

	case protocol.MsgConfigSync:
		var syncCfg protocol.ConfigSyncPayload
		if json.Unmarshal(env.Payload, &syncCfg) == nil {
			if err := config.SaveSnapshot(c.cfg.DataDir, syncCfg); err != nil {
				slog.Warn("save config snapshot failed", "err", err)
			}
			if c.scheduler != nil {
				c.scheduler.ApplyConfig(ctx, syncCfg.Targets)
			}
			slog.Info("applied config sync", "version", syncCfg.ConfigVersion, "targets", len(syncCfg.Targets))
		}

	case protocol.MsgAck:
		var ack protocol.AckPayload
		if json.Unmarshal(env.Payload, &ack) == nil {
			if chVal, ok := c.ackWait.LoadAndDelete(ack.BatchID); ok {
				close(chVal.(chan struct{}))
			}
		}

	case protocol.MsgRunMTR:
		var req protocol.RunMTRPayload
		if json.Unmarshal(env.Payload, &req) == nil {
			go c.runOnDemandMTR(req)
		}
	}
}

func (c *Client) runOnDemandMTR(req protocol.RunMTRPayload) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	hops, err := engine.RunMTRWithFamily(ctx, req.Host, strings.HasSuffix(req.ProbeType, "6"))
	if hops == nil {
		hops = []protocol.MTRHop{}
	}
	res := protocol.MTRResultPayload{
		BatchID:       uuid.NewString(),
		RequestID:     req.RequestID,
		TargetID:      req.TargetID,
		CapturedAtNs:  c.clk.AdjustedNowUnixNs(),
		TriggerReason: "manual",
		Hops:          hops,
	}
	if err != nil {
		slog.Warn("manual mtr failed", "target_id", req.TargetID, "host", req.Host, "err", err)
		res.Error = err.Error()
	}
	select {
	case c.mtrCh <- res:
	default:
		_ = c.buf.EnqueueMTR(context.Background(), res)
	}
}

func (c *Client) batchFlusherLoop(ctx context.Context) {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()

	batch := make([]protocol.SampleRecord, 0, 128)
	flush := func() {
		if len(batch) == 0 {
			return
		}
		toSend := append([]protocol.SampleRecord(nil), batch...)
		batch = batch[:0]

		conn := c.getConn()
		if conn == nil {
			if err := c.buf.EnqueueSamples(ctx, toSend); err != nil {
				slog.Error("enqueue offline samples failed", "err", err)
			}
			return
		}

		backlog, _ := c.buf.CountSamples(ctx)
		batchID := uuid.NewString()
		if !c.sendBatchAwaitAck(ctx, conn, protocol.MsgSamplesLive, protocol.SamplesBatchPayload{
			BatchID:       batchID,
			BacklogCount:  backlog,
			ClockOffsetMs: c.clk.OffsetMs(),
			Samples:       toSend,
		}, 4*time.Second) {
			if err := c.buf.EnqueueSamples(ctx, toSend); err != nil {
				slog.Error("enqueue unacked samples failed", "err", err)
			}
		}
	}

	for {
		select {
		case <-ctx.Done():
			if len(batch) > 0 {
				saveCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
				_ = c.buf.EnqueueSamples(saveCtx, batch)
				cancel()
			}
			return
		case rec := <-c.liveCh:
			batch = append(batch, rec)
			if len(batch) >= 100 {
				flush()
			}
		case <-ticker.C:
			flush()
		}
	}
}

func (c *Client) mtrLoop(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case res := <-c.mtrCh:
			conn := c.getConn()
			if conn == nil || !c.sendMTRAwaitAck(ctx, conn, res, 5*time.Second) {
				_ = c.buf.EnqueueMTR(ctx, res)
			}
		}
	}
}

func (c *Client) backfillLoop(ctx context.Context) {
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			conn := c.getConn()
			if conn == nil {
				continue
			}

			// Drain pending MTRs first
			mtrItems, err := c.buf.PeekMTR(ctx, 10)
			if err == nil {
				for _, item := range mtrItems {
					if c.getConn() != conn {
						break
					}
					if item.Payload.BatchID == "" {
						item.Payload.BatchID = uuid.NewString()
					}
					if c.sendMTRAwaitAck(ctx, conn, item.Payload, 5*time.Second) {
						_ = c.buf.AckMTR(ctx, item.ID)
					} else {
						break
					}
				}
			}

			// Drain sample chunks (up to 5 chunks x 500 rows per second)
			for chunk := 0; chunk < 5; chunk++ {
				if c.getConn() != conn {
					break
				}
				maxID, rows, err := c.buf.PeekSamples(ctx, 500)
				if err != nil || len(rows) == 0 {
					break
				}
				backlog, _ := c.buf.CountSamples(ctx)
				remaining := backlog - int64(len(rows))
				if remaining < 0 {
					remaining = 0
				}
				batchID := uuid.NewString()
				if !c.sendBatchAwaitAck(ctx, conn, protocol.MsgSamplesBackfill, protocol.SamplesBatchPayload{
					BatchID:       batchID,
					BacklogCount:  remaining,
					ClockOffsetMs: c.clk.OffsetMs(),
					Samples:       rows,
				}, 8*time.Second) {
					break
				}
				if err := c.buf.AckSamplesUpTo(ctx, maxID); err != nil {
					slog.Warn("ack sqlite delete failed", "err", err)
					break
				}
			}
		}
	}
}

func (c *Client) retentionLoop(ctx context.Context) {
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := c.buf.EnforceRetention(ctx, c.cfg.MaxBufferHours, c.cfg.MaxBufferMB, time.Now().UTC()); err != nil {
				slog.Warn("buffer retention enforce failed", "err", err)
			}
		}
	}
}

func (c *Client) sendBatchAwaitAck(ctx context.Context, conn *websocket.Conn, msgType string, payload protocol.SamplesBatchPayload, timeout time.Duration) bool {
	ackCh := make(chan struct{})
	c.ackWait.Store(payload.BatchID, ackCh)
	defer c.ackWait.Delete(payload.BatchID)

	if err := c.writeFrame(ctx, conn, msgType, payload); err != nil {
		return false
	}

	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-ackCh:
		return true
	case <-timer.C:
		return false
	case <-ctx.Done():
		return false
	}
}

func (c *Client) sendMTRAwaitAck(ctx context.Context, conn *websocket.Conn, payload protocol.MTRResultPayload, timeout time.Duration) bool {
	if payload.BatchID == "" {
		payload.BatchID = uuid.NewString()
	}
	ackCh := make(chan struct{})
	c.ackWait.Store(payload.BatchID, ackCh)
	defer c.ackWait.Delete(payload.BatchID)

	if err := c.writeFrame(ctx, conn, protocol.MsgMTRResult, payload); err != nil {
		return false
	}

	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-ackCh:
		return true
	case <-timer.C:
		return false
	case <-ctx.Done():
		return false
	}
}

func (c *Client) sendClockPing(ctx context.Context, conn *websocket.Conn) {
	seq := c.pingSeq.Add(1)
	t1 := time.Now().UTC().UnixNano()
	c.pingSend.Store(seq, t1)
	_ = c.writeFrame(ctx, conn, protocol.MsgClockPing, protocol.ClockPingPayload{
		Seq: seq,
		T1:  t1,
	})
}

func (c *Client) writeFrame(ctx context.Context, conn *websocket.Conn, msgType string, payload any) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	frame, err := json.Marshal(protocol.Envelope{
		Type:    msgType,
		Payload: raw,
	})
	if err != nil {
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	wCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return conn.Write(wCtx, websocket.MessageText, frame)
}

func (c *Client) setConn(conn *websocket.Conn) {
	c.connMu.Lock()
	c.conn = conn
	c.connMu.Unlock()
}

func (c *Client) clearConn(conn *websocket.Conn) {
	c.connMu.Lock()
	if c.conn == conn {
		c.conn = nil
	}
	c.connMu.Unlock()
}

func (c *Client) getConn() *websocket.Conn {
	c.connMu.RLock()
	defer c.connMu.RUnlock()
	return c.conn
}
