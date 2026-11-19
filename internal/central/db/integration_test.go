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
		AlertsEnabled:    true,
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

	// Verify migration 007 columns & alert persistence (severity_filter, telegram_message_ids, ack, target mute)
	muteAt := time.Now().UTC().Add(30 * time.Minute).Truncate(time.Microsecond)
	mutedTarget, err := store.SetTargetMute(ctx, target.ID, &muteAt)
	if err != nil || mutedTarget.MutedUntil == nil {
		t.Fatalf("SetTargetMute failed: target=%+v err=%v", mutedTarget, err)
	}
	unmutedTarget, err := store.SetTargetMute(ctx, target.ID, nil)
	if err != nil || unmutedTarget.MutedUntil != nil {
		t.Fatalf("SetTargetMute clear failed: target=%+v err=%v", unmutedTarget, err)
	}

	ch, err := store.CreateAlertChannel(ctx, "telegram", "Int Test TG", []byte("enc"), "chat:-1001", "critical", true)
	if err != nil || ch.SeverityFilter != "critical" {
		t.Fatalf("CreateAlertChannel failed: ch=%+v err=%v", ch, err)
	}
	defer func() { _ = store.DeleteAlertChannel(context.Background(), ch.ID) }()

	chUpd, err := store.UpdateAlertChannel(ctx, ch.ID, "Int Test TG 2", []byte("enc2"), "chat:-1002", "all", true)
	if err != nil || chUpd.SeverityFilter != "all" {
		t.Fatalf("UpdateAlertChannel failed: ch=%+v err=%v", chUpd, err)
	}

	rule, err := store.CreateAlertRule(ctx, db.AlertRuleInput{
		Name:            "Int Test Rule",
		TargetID:        &target.ID,
		Metric:          "loss_pct",
		ThresholdValue:  20,
		DurationSec:     30,
		QuorumMinProbes: 1,
		CooldownSec:     0,
		ConfirmSec:      0,
		RecoverSec:      45,
		Enabled:         true,
	})
	if err != nil {
		t.Fatalf("CreateAlertRule failed: %v", err)
	}
	defer func() { _ = store.DeleteAlertRule(context.Background(), rule.ID) }()

	tNow := time.Now().UTC().Truncate(time.Microsecond)
	inc, isNew, _, err := store.UpsertOpenIncident(ctx, rule.ID, &target.ID, []string{"Integration Probe"}, 30, "warn", tNow, "Unstable")
	if err != nil || !isNew {
		t.Fatalf("UpsertOpenIncident failed: inc=%+v isNew=%v err=%v", inc, isNew, err)
	}
	if err := store.MarkIncidentNotified(ctx, inc.ID, "", time.Time{}, map[string]int64{ch.ID.String(): 555}); err != nil {
		t.Fatalf("MarkIncidentNotified partial failed: %v", err)
	}
	if err := store.MarkIncidentNotified(ctx, inc.ID, "warn", tNow, map[string]int64{"fired:" + ch.ID.String(): 1}); err != nil {
		t.Fatalf("MarkIncidentNotified final failed: %v", err)
	}
	acked, err := store.AcknowledgeIncident(ctx, inc.ID, "admin", tNow.Add(5*time.Second))
	if err != nil || acked.AcknowledgedAt == nil || acked.AcknowledgedBy != "admin" {
		t.Fatalf("AcknowledgeIncident failed: acked=%+v err=%v", acked, err)
	}
	resolved, err := store.ResolveOpenIncident(ctx, rule.ID, &target.ID, tNow.Add(time.Minute))
	if err != nil || resolved == nil || resolved.TelegramMessageIDs[ch.ID.String()] != 555 || resolved.TelegramMessageIDs["fired:"+ch.ID.String()] != 1 || resolved.NotifiedSeverity != "warn" {
		t.Fatalf("ResolveOpenIncident failed: resolved=%+v err=%v", resolved, err)
	}

	// Verify migration 009 columns & controls (SetAlertingEnabled, CloseIncidentByID, ClearIncidents, AlertsEnabled=false auto-close)
	st, err := store.GetSettings(ctx)
	if err != nil || !st.AlertingEnabled {
		t.Fatalf("expected default alerting_enabled=true, got st=%+v err=%v", st, err)
	}
	stOff, err := store.SetAlertingEnabled(ctx, false)
	if err != nil || stOff.AlertingEnabled {
		t.Fatalf("SetAlertingEnabled(false) failed: st=%+v err=%v", stOff, err)
	}
	stPreserved, err := store.UpdateSettingsAndRetention(ctx, stOff.RawRetentionDays, stOff.AggRetentionDays, stOff.DefaultQuorumMin, stOff.BrandName, nil)
	if err != nil || stPreserved.AlertingEnabled {
		t.Fatalf("UpdateSettingsAndRetention(nil) should preserve alerting_enabled=false, got st=%+v err=%v", stPreserved, err)
	}
	if stOn, err := store.SetAlertingEnabled(ctx, true); err != nil || !stOn.AlertingEnabled {
		t.Fatalf("SetAlertingEnabled(true) failed: st=%+v err=%v", stOn, err)
	}

	// Manual CloseIncidentByID
	inc2, isNew2, _, err := store.UpsertOpenIncident(ctx, rule.ID, &target.ID, []string{"Integration Probe"}, 55, "critical", tNow.Add(2*time.Minute), "Outage")
	if err != nil || !isNew2 {
		t.Fatalf("second UpsertOpenIncident failed: inc=%+v isNew=%v err=%v", inc2, isNew2, err)
	}
	closed, err := store.CloseIncidentByID(ctx, inc2.ID, "admin", tNow.Add(3*time.Minute))
	if err != nil || closed.Status != "resolved" || closed.ResolvedAt == nil {
		t.Fatalf("CloseIncidentByID failed: closed=%+v err=%v", closed, err)
	}

	// Switching target to Monitoring Only (alerts_enabled=false) must auto-close open incidents for that target
	inc3, isNew3, _, err := store.UpsertOpenIncident(ctx, rule.ID, &target.ID, []string{"Integration Probe"}, 40, "warn", tNow.Add(4*time.Minute), "Degraded")
	if err != nil || !isNew3 {
		t.Fatalf("third UpsertOpenIncident failed: inc=%+v isNew=%v err=%v", inc3, isNew3, err)
	}
	monOnly, err := store.UpdateTarget(ctx, target.ID, db.TargetInput{
		Name:             target.Name,
		Host:             target.Host,
		ProbeType:        target.ProbeType,
		IntervalSec:      target.IntervalSec,
		TimeoutMs:        target.TimeoutMs,
		Enabled:          true,
		AlertsEnabled:    false,
		AutoMTROnLoss:    true,
		MTRLossThreshold: 3,
		AssignAllProbes:  true,
	})
	if err != nil || monOnly.AlertsEnabled {
		t.Fatalf("UpdateTarget(AlertsEnabled=false) failed: target=%+v err=%v", monOnly, err)
	}
	openCount, err := store.CountOpenIncidents(ctx)
	if err != nil || openCount != 0 {
		t.Fatalf("expected open incidents to auto-close on Monitoring Only switch, got openCount=%d err=%v", openCount, err)
	}

	// ClearIncidents(false) deletes resolved incidents only; ClearIncidents(true) deletes all
	inc4, _, _, err := store.UpsertOpenIncident(ctx, rule.ID, &target.ID, []string{"Integration Probe"}, 45, "warn", tNow.Add(5*time.Minute), "Open for clear test")
	if err != nil || inc4.Status != "open" {
		t.Fatalf("fourth UpsertOpenIncident failed: inc=%+v err=%v", inc4, err)
	}
	clearedResolved, err := store.ClearIncidents(ctx, false)
	if err != nil || clearedResolved < 3 {
		t.Fatalf("ClearIncidents(false) expected >=3 resolved rows cleared, got %d err=%v", clearedResolved, err)
	}
	remaining, err := store.ListIncidents(ctx, 50)
	if err != nil || len(remaining) != 1 || remaining[0].ID != inc4.ID {
		t.Fatalf("expected only open incident to remain after ClearIncidents(false), got %+v err=%v", remaining, err)
	}
	clearedAll, err := store.ClearIncidents(ctx, true)
	if err != nil || clearedAll != 1 {
		t.Fatalf("ClearIncidents(true) expected 1 row cleared, got %d err=%v", clearedAll, err)
	}

	// Verify migration 010 tv_presets CRUD and single-default uniqueness
	pA, err := store.CreateTVPreset(ctx, db.TVPresetInput{
		Slug:      "noc-main",
		Name:      "NOC Main Wall",
		Config:    []byte(`{"range":"3h","layoutMode":"auto"}`),
		IsDefault: true,
	})
	if err != nil || !pA.IsDefault || pA.Slug != "noc-main" {
		t.Fatalf("CreateTVPreset A failed: p=%+v err=%v", pA, err)
	}
	pB, err := store.CreateTVPreset(ctx, db.TVPresetInput{
		Slug:      "core-4k",
		Name:      "Core Links 4K",
		Config:    []byte(`{"range":"1h","layoutMode":"single-col"}`),
		IsDefault: true, // atomically supersedes pA as default
	})
	if err != nil || !pB.IsDefault {
		t.Fatalf("CreateTVPreset B failed: p=%+v err=%v", pB, err)
	}
	presets, err := store.ListTVPresets(ctx)
	if err != nil || len(presets) != 2 || !presets[0].IsDefault || presets[0].ID != pB.ID || presets[1].IsDefault {
		t.Fatalf("expected pB as sole default first in ListTVPresets, got %+v err=%v", presets, err)
	}
	if err := store.DeleteTVPreset(ctx, pA.ID); err != nil {
		t.Fatalf("DeleteTVPreset A failed: %v", err)
	}
	if err := store.DeleteTVPreset(ctx, pB.ID); err != nil {
		t.Fatalf("DeleteTVPreset B failed: %v", err)
	}
}
