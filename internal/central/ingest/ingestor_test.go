package ingest

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"smoker/internal/central/db"
)

func TestRollingCacheSparklineAndStatus(t *testing.T) {
	t.Parallel()

	cache := NewRollingCache(10 * time.Minute)
	probeID := uuid.New()
	targetID := uuid.New()
	now := time.Now().UTC()

	for i := 59; i >= 0; i-- {
		ts := now.Add(-time.Duration(i) * time.Second)
		if i == 5 {
			cache.Add(probeID, targetID, ts, nil, 0, true, now)
			continue
		}
		rtt := int32(10000 + (i%5)*1000) // 10..14ms
		cache.Add(probeID, targetID, ts, &rtt, 250, false, now)
	}

	cells := cache.BuildMatrixCells(
		[]db.Target{{ID: targetID, AssignAllProbes: true, TimeoutMs: 1000}},
		[]db.Probe{{ID: probeID}},
		now,
	)
	if len(cells) != 1 {
		t.Fatalf("expected 1 cell, got %d", len(cells))
	}
	cell := cells[0]
	if cell.SampleCount != 60 {
		t.Fatalf("expected 60 samples, got %d", cell.SampleCount)
	}
	if cell.Status != "loss" {
		t.Fatalf("expected status loss, got %s", cell.Status)
	}
	if len(cell.Sparkline) != 36 {
		t.Fatalf("expected downsampled 36 sparkline points, got %d", len(cell.Sparkline))
	}
	var sawLoss bool
	for _, pt := range cell.Sparkline {
		if pt.Loss > 0 {
			sawLoss = true
		}
	}
	if !sawLoss {
		t.Fatal("expected sparkline bucket to preserve packet loss indicator")
	}
	if cell.BaselineMs == nil || *cell.BaselineMs <= 0 {
		t.Fatalf("expected BaselineMs > 0, got %v", cell.BaselineMs)
	}
	if cell.WarnMs == nil || *cell.WarnMs <= 0 {
		t.Fatalf("expected WarnMs > 0, got %v", cell.WarnMs)
	}

	ws := cache.WindowStats(targetID, probeID, 60*time.Second, now)
	if ws.P50Ms < 10 || ws.P50Ms > 14 {
		t.Fatalf("expected WindowStats.P50Ms in [10,14], got %v", ws.P50Ms)
	}
	if ws.LastRTTMs != 10 {
		t.Fatalf("expected WindowStats.LastRTTMs=10 (most recent sample i=0), got %v", ws.LastRTTMs)
	}
}

func TestRollingCacheMultiProbeAutoBaselineAndSimulation(t *testing.T) {
	t.Parallel()

	cache := NewRollingCache(10 * time.Minute)
	tID := uuid.New()
	probeNear := uuid.New()
	probeFar := uuid.New()
	now := time.Now().UTC()

	// Seed 5 minutes of historical baseline samples (-300s to -120s):
	// probeNear has best-path ~8ms; probeFar has best-path ~60ms
	rttNearBase := int32(8000)
	rttFarBase := int32(60000)
	for i := 300; i >= 120; i -= 5 {
		ts := now.Add(-time.Duration(i) * time.Second)
		cache.Add(probeNear, tID, ts, &rttNearBase, 200, false, now)
		cache.Add(probeFar, tID, ts, &rttFarBase, 800, false, now)
	}

	// In the last 30s, probeNear spikes to 35ms (above its 23ms auto-warn), while probeFar is at 65ms (normal for 60ms baseline, warn=120ms)
	rttNearSpike := int32(35000)
	rttFarNormal := int32(65000)
	for i := 30; i >= 5; i -= 5 {
		ts := now.Add(-time.Duration(i) * time.Second)
		cache.Add(probeNear, tID, ts, &rttNearSpike, 2000, false, now)
		cache.Add(probeFar, tID, ts, &rttFarNormal, 1000, false, now)
	}

	targets := []db.Target{{ID: tID, AssignAllProbes: true, TimeoutMs: 1000}}
	probes := []db.Probe{{ID: probeNear, Name: "Near"}, {ID: probeFar, Name: "Far"}}

	cells := cache.BuildMatrixCells(targets, probes, now)
	if len(cells) != 2 {
		t.Fatalf("expected 2 cells, got %d", len(cells))
	}
	if cells[0].Status != "degraded" {
		t.Fatalf("expected probeNear status=degraded, got %s (P50=%v, Base=%v, Warn=%v)", cells[0].Status, cells[0].P50Ms, cells[0].BaselineMs, cells[0].WarnMs)
	}
	if cells[1].Status != "healthy" {
		t.Fatalf("expected probeFar status=healthy, got %s (P50=%v, Base=%v, Warn=%v)", cells[1].Status, cells[1].P50Ms, cells[1].BaselineMs, cells[1].WarnMs)
	}

	// Simulate high_latency on probeFar
	cache.SimulateAnomaly(tID, []uuid.UUID{probeFar}, "high_latency", 30*time.Second, now)
	simCells := cache.BuildMatrixCells(targets, probes, now)
	if simCells[1].Status != "degraded" {
		t.Fatalf("expected simulated probeFar status=degraded, got %s", simCells[1].Status)
	}

	// Clear simulation
	cache.SimulateAnomaly(tID, []uuid.UUID{probeFar}, "clear", 0, now)
	clearedCells := cache.BuildMatrixCells(targets, probes, now)
	if clearedCells[1].Status != "healthy" {
		t.Fatalf("expected cleared probeFar status=healthy, got %s", clearedCells[1].Status)
	}
}
