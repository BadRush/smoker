//go:build integration

package db_test

import (
	"context"
	"os"
	"testing"
	"time"

	"smoker/internal/central/config"
	"smoker/internal/central/db"
	"smoker/internal/central/ingest"
	"smoker/internal/protocol"
)

func TestTimescaleMigrationsAndIdempotentIngest(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	pool, err := db.NewPool(ctx, dsn)
	if err != nil {
		t.Fatalf("NewPool failed: %v", err)
	}
	defer pool.Close()

	if err := db.RunMigrations(ctx, pool); err != nil {
		t.Fatalf("RunMigrations failed: %v", err)
	}

	store := db.NewStore(pool)
	err = store.EnsureBootstrap(ctx, config.CentralConfig{
		AdminUsername:        "admin",
		AdminPassword:        "smoker_test_pass_123",
		JWTSecret:            "test-jwt-secret-min-32-characters",
		AppEncryptionKey:     "test-enc-secret-min-32-characters",
		LocalProbeAutoEnroll: true,
		LocalProbeName:       "Integration Probe",
		LocalProbeLocation:   "Test Host",
		LocalProbeToken:      "smk_integration_test_token",
	})
	if err != nil {
		t.Fatalf("EnsureBootstrap failed: %v", err)
	}

	probes, err := store.ListProbes(ctx)
	if err != nil || len(probes) == 0 {
		t.Fatalf("ListProbes failed: %v (len=%d)", err, len(probes))
	}
	probeID := probes[0].ID

	target, err := store.CreateTarget(ctx, db.TargetInput{
		Name:             "Integration Test 1.1.1.1",
		Host:             "1.1.1.1",
		ProbeType:        "icmp",
		IntervalSec:      1,
		TimeoutMs:        1000,
		Enabled:          true,
		AutoMTROnLoss:    true,
		MTRLossThreshold: 3,
		AssignAllProbes:  true,
	})
	if err != nil {
		t.Fatalf("CreateTarget failed: %v", err)
	}
	defer func() { _ = store.DeleteTarget(context.Background(), target.ID) }()

	ing := ingest.NewIngestor(pool, ingest.NewRollingCache(10*time.Minute))
	rtt := int32(14200)
	ts := time.Now().UTC().Truncate(time.Second)
	records := []protocol.SampleRecord{
		{TimestampNs: ts.Add(-2 * time.Second).UnixNano(), TargetID: target.ID.String(), RTTUs: &rtt, JitterUs: 150, IsLoss: false},
		{TimestampNs: ts.Add(-1 * time.Second).UnixNano(), TargetID: target.ID.String(), RTTUs: nil, JitterUs: 0, IsLoss: true},
	}

	// First live insert + duplicate backfill replay must yield exactly 2 rows
	if _, err := ing.IngestBatch(ctx, probeID, false, records); err != nil {
		t.Fatalf("live ingest failed: %v", err)
	}
	if _, err := ing.IngestBatch(ctx, probeID, true, records); err != nil {
		t.Fatalf("backfill replay failed: %v", err)
	}

	var count int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM ping_samples WHERE target_id = $1 AND probe_id = $2`, target.ID, probeID).Scan(&count); err != nil {
		t.Fatalf("count ping_samples failed: %v", err)
	}
	if count != 2 {
		t.Fatalf("expected 2 idempotent rows, got %d", count)
	}

	for _, r := range []string{"5m", "15m", "24h", "7d", "30d", "1y"} {
		res, err := store.QueryTargetSeries(ctx, target.ID, r)
		if err != nil {
			t.Fatalf("QueryTargetSeries(%s) failed: %v", r, err)
		}
		if r == "5m" && (len(res.Series) == 0 || len(res.Series[0].Timestamps) != 2) {
			t.Fatalf("expected 2 points in 5m series, got %+v", res.Series)
		}
	}

	// Verify idempotent starter preset seeding (Public DNS & Public Apps)
	if _, err := store.SeedPublicMonitors(ctx, false); err != nil {
		t.Fatalf("SeedPublicMonitors(false) failed: %v", err)
	}
	res2, err := store.SeedPublicMonitors(ctx, false)
	if err != nil {
		t.Fatalf("second SeedPublicMonitors(false) failed: %v", err)
	}
	if res2.GroupsCreated != 0 || res2.TargetsCreated != 0 {
		t.Fatalf("expected idempotent 0/0 on repeat seed, got %+v", res2)
	}
}
