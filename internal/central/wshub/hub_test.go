package wshub

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/google/uuid"
	"smoker/internal/central/db"
	"smoker/internal/protocol"
)

func TestHandleProbeMTRResultSkipsEmptyHopsAndBroadcastsError(t *testing.T) {
	t.Parallel()

	targetID := uuid.New()
	ch := "target:" + targetID.String()

	h := NewHub(nil, nil, "test-jwt-secret")
	pc := &probeConn{
		probe: db.Probe{ID: uuid.New(), Name: "probe-local"},
		send:  make(chan []byte, 4),
	}
	ui := &uiClient{
		send: make(chan []byte, 4),
		subs: map[string]bool{ch: true},
	}
	h.uiClients[ui] = struct{}{}

	payloadBytes, err := json.Marshal(protocol.MTRResultPayload{
		BatchID:       "batch-err-1",
		TargetID:      targetID.String(),
		TriggerReason: "manual",
		Hops:          []protocol.MTRHop{},
		Error:         "resolve invalid.local: no such host",
	})
	if err != nil {
		t.Fatal(err)
	}

	h.handleProbeMessage(context.Background(), pc, protocol.Envelope{
		Type:    protocol.MsgMTRResult,
		Payload: payloadBytes,
	})

	// 1. Probe receives ACK so uplink drops the failed item instead of retrying forever
	select {
	case rawAck := <-pc.send:
		var env protocol.Envelope
		if err := json.Unmarshal(rawAck, &env); err != nil || env.Type != protocol.MsgAck {
			t.Fatalf("expected ack envelope, got %s (%v)", string(rawAck), err)
		}
	default:
		t.Fatalf("expected Ack frame queued for probe")
	}

	// 2. Subscribed UI receives mtr_ready event carrying the error payload
	select {
	case rawUI := <-ui.send:
		var ev struct {
			Type    string `json:"type"`
			Channel string `json:"channel"`
			Data    struct {
				TargetID string `json:"target_id"`
				Error    string `json:"error"`
			} `json:"data"`
		}
		if err := json.Unmarshal(rawUI, &ev); err != nil {
			t.Fatalf("decode ui event failed: %v", err)
		}
		if ev.Type != "mtr_ready" || ev.Data.TargetID != targetID.String() || ev.Data.Error == "" {
			t.Fatalf("unexpected UI mtr_ready payload: %+v", ev)
		}
	default:
		t.Fatalf("expected mtr_ready error event broadcast to UI")
	}
}

func TestUpdateProbeMetaUpdatesConnAndBroadcastsMatrix(t *testing.T) {
	t.Parallel()

	probeID := uuid.New()
	h := NewHub(nil, nil, "test-jwt-secret")
	pc := &probeConn{
		probe: db.Probe{ID: probeID, Name: "Local Central Probe", LocationLabel: "Central Host"},
		send:  make(chan []byte, 4),
	}
	h.probes[probeID] = pc

	ui := &uiClient{
		send: make(chan []byte, 4),
		subs: map[string]bool{"matrix": true},
	}
	h.uiClients[ui] = struct{}{}

	h.UpdateProbeMeta(db.Probe{
		ID:            probeID,
		Name:          "NOC-Jakarta-Core",
		LocationLabel: "IDC 3D",
		ISPAsn:        "AS13335",
		Status:        "online",
	})

	if got := pc.probeName(); got != "NOC-Jakarta-Core" {
		t.Fatalf("expected updated probeName NOC-Jakarta-Core, got %q", got)
	}

	select {
	case rawUI := <-ui.send:
		var ev struct {
			Type string `json:"type"`
			Data struct {
				ProbeID       string `json:"probe_id"`
				ProbeName     string `json:"probe_name"`
				LocationLabel string `json:"location_label"`
			} `json:"data"`
		}
		if err := json.Unmarshal(rawUI, &ev); err != nil {
			t.Fatalf("decode ui event failed: %v", err)
		}
		if ev.Type != "probe_status" || ev.Data.ProbeID != probeID.String() || ev.Data.ProbeName != "NOC-Jakarta-Core" {
			t.Fatalf("unexpected probe_status broadcast: %+v", ev)
		}
	default:
		t.Fatalf("expected probe_status event broadcast to matrix subscribers")
	}
}
