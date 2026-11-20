package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"smoker/internal/central/alerts"
	"smoker/internal/central/auth"
	"smoker/internal/central/config"
	"smoker/internal/central/db"
	"smoker/internal/central/ingest"
	"smoker/internal/protocol"
)

type fakeHub struct {
	updatedProbes   []db.Probe
	broadcastEvents []protocol.LiveEvent
}

func (h *fakeHub) HandleProbeWS(http.ResponseWriter, *http.Request) {}
func (h *fakeHub) HandleLiveWS(http.ResponseWriter, *http.Request)  {}
func (h *fakeHub) SyncAllProbes(context.Context)                    {}
func (h *fakeHub) UpdateProbeMeta(probe db.Probe) {
	h.updatedProbes = append(h.updatedProbes, probe)
}
func (h *fakeHub) SendRunMTR(context.Context, db.Target, *uuid.UUID) ([]string, error) {
	return nil, nil
}
func (h *fakeHub) BroadcastUI(_ string, ev protocol.LiveEvent) {
	h.broadcastEvents = append(h.broadcastEvents, ev)
}

type fakeStore struct {
	adminHash        string
	targets          []db.Target
	probes           []db.Probe
	alertRules       []db.AlertRule
	alertChannels    []db.AlertChannel
	incidents        []db.Incident
	brandName        string
	alertingDisabled bool
	tvPresets        []db.TVPreset
}

func (f *fakeStore) Ping(context.Context) error { return nil }
func (f *fakeStore) GetAdminByUsername(_ context.Context, u string) (db.AdminUser, error) {
	if u != "admin" {
		return db.AdminUser{}, db.ErrNotFound
	}
	return db.AdminUser{Username: "admin", PasswordHash: f.adminHash}, nil
}
func (f *fakeStore) UpdateAdminPassword(context.Context, string, string) error { return nil }
func (f *fakeStore) ListProbes(context.Context) ([]db.Probe, error)           { return f.probes, nil }
func (f *fakeStore) CreateProbe(_ context.Context, name, loc, isp, _ string) (db.Probe, error) {
	p := db.Probe{
		ID:            uuid.New(),
		Name:          name,
		LocationLabel: loc,
		ISPAsn:        isp,
		Status:        "offline",
		CreatedAt:     time.Now().UTC(),
	}
	f.probes = append(f.probes, p)
	return p, nil
}
func (f *fakeStore) UpdateProbe(_ context.Context, id uuid.UUID, name, loc, isp string) (db.Probe, error) {
	for i, p := range f.probes {
		if p.ID == id {
			p.Name = name
			p.LocationLabel = loc
			p.ISPAsn = isp
			f.probes[i] = p
			return p, nil
		}
	}
	return db.Probe{}, db.ErrNotFound
}
func (f *fakeStore) RotateProbeToken(context.Context, uuid.UUID, string) (db.Probe, error) {
	return db.Probe{}, nil
}
func (f *fakeStore) DeleteProbe(_ context.Context, id uuid.UUID) error {
	var blocking []string
	for _, t := range f.targets {
		if t.Enabled && !t.AssignAllProbes && len(t.ProbeIDs) == 1 && t.ProbeIDs[0] == id {
			blocking = append(blocking, t.Name)
		}
	}
	if len(blocking) > 0 {
		return &db.ProbeInUseError{TargetNames: blocking}
	}
	return nil
}
func (f *fakeStore) ListGroups(context.Context) ([]db.TargetGroup, error)     { return []db.TargetGroup{}, nil }
func (f *fakeStore) CreateGroup(context.Context, string, *uuid.UUID, string, int) (db.TargetGroup, error) {
	return db.TargetGroup{}, nil
}
func (f *fakeStore) UpdateGroup(context.Context, uuid.UUID, string, *uuid.UUID, string, int) (db.TargetGroup, error) {
	return db.TargetGroup{}, nil
}
func (f *fakeStore) DeleteGroup(context.Context, uuid.UUID) error { return nil }
func (f *fakeStore) ListTargets(context.Context) ([]db.Target, error) {
	return f.targets, nil
}
func (f *fakeStore) GetTarget(_ context.Context, id uuid.UUID) (db.Target, error) {
	for _, t := range f.targets {
		if t.ID == id {
			return t, nil
		}
	}
	return db.Target{}, db.ErrNotFound
}
func (f *fakeStore) CreateTarget(_ context.Context, in db.TargetInput) (db.Target, error) {
	probeIDs := in.ProbeIDs
	if probeIDs == nil {
		probeIDs = []uuid.UUID{}
	}
	overrides := in.ProbeLatencyOverrides
	if overrides == nil {
		overrides = map[string]int{}
	}
	t := db.Target{
		ID:                    uuid.New(),
		Name:                  in.Name,
		Host:                  in.Host,
		ProbeType:             in.ProbeType,
		IntervalSec:           in.IntervalSec,
		TimeoutMs:             in.TimeoutMs,
		Enabled:               in.Enabled,
		AlertsEnabled:         in.AlertsEnabled,
		AssignAllProbes:       in.AssignAllProbes,
		ProbeIDs:              probeIDs,
		ProbeLatencyOverrides: overrides,
		CreatedAt:             time.Now().UTC(),
		UpdatedAt:             time.Now().UTC(),
	}
	f.targets = append(f.targets, t)
	return t, nil
}
func (f *fakeStore) UpdateTarget(_ context.Context, id uuid.UUID, in db.TargetInput) (db.Target, error) {
	for i, existing := range f.targets {
		if existing.ID == id {
			probeIDs := in.ProbeIDs
			if probeIDs == nil {
				probeIDs = []uuid.UUID{}
			}
			existing.Name = in.Name
			existing.Host = in.Host
			existing.ProbeType = in.ProbeType
			existing.Enabled = in.Enabled
			existing.AlertsEnabled = in.AlertsEnabled
			existing.AssignAllProbes = in.AssignAllProbes
			existing.ProbeIDs = probeIDs
			existing.ProbeLatencyOverrides = in.ProbeLatencyOverrides
			f.targets[i] = existing
			if !in.AlertsEnabled {
				now := time.Now().UTC()
				for j, inc := range f.incidents {
					if inc.Status == "open" && inc.TargetID != nil && *inc.TargetID == id {
						inc.Status = "resolved"
						inc.ResolvedAt = &now
						f.incidents[j] = inc
					}
				}
			}
			return existing, nil
		}
	}
	return db.Target{}, db.ErrNotFound
}
func (f *fakeStore) SetTargetMute(_ context.Context, id uuid.UUID, mutedUntil *time.Time) (db.Target, error) {
	for i, existing := range f.targets {
		if existing.ID == id {
			existing.MutedUntil = mutedUntil
			f.targets[i] = existing
			return existing, nil
		}
	}
	return db.Target{}, db.ErrNotFound
}
func (f *fakeStore) DeleteTarget(context.Context, uuid.UUID) error { return nil }
func (f *fakeStore) SeedPublicMonitors(context.Context, bool) (db.SeedResult, error) {
	return db.SeedResult{GroupsCreated: 2, TargetsCreated: 18}, nil
}
func (f *fakeStore) QueryTargetSeries(ctx context.Context, id uuid.UUID, rangeKey string) (db.TargetSeriesResponse, error) {
	return f.QueryTargetSeriesWindow(ctx, id, db.SeriesWindow{RangeKey: rangeKey})
}
func (f *fakeStore) QueryTargetSeriesWindow(_ context.Context, id uuid.UUID, win db.SeriesWindow) (db.TargetSeriesResponse, error) {
	rangeKey := win.RangeKey
	if rangeKey == "" {
		rangeKey = "5m"
	}
	var fromUnix, toUnix *int64
	if win.IsCustom() {
		rangeKey = "custom"
		fSec := win.From.Unix()
		tSec := win.To.Unix()
		fromUnix = &fSec
		toUnix = &tSec
	}
	for _, tgt := range f.targets {
		if tgt.ID == id {
			series := make([]db.ProbeSeries, 0, len(f.probes))
			for _, p := range f.probes {
				series = append(series, db.ProbeSeries{
					ProbeID:       p.ID,
					ProbeName:     p.Name,
					LocationLabel: p.LocationLabel,
				})
			}
			return db.TargetSeriesResponse{
				Target:    tgt,
				Range:     rangeKey,
				BucketSec: 1,
				FromUnix:  fromUnix,
				ToUnix:    toUnix,
				Series:    series,
			}, nil
		}
	}
	return db.TargetSeriesResponse{}, nil
}
func (f *fakeStore) QueryBatchTargetSeries(ctx context.Context, ids []uuid.UUID, rangeKey string) (db.BatchSeriesResponse, error) {
	return f.QueryBatchTargetSeriesWindow(ctx, ids, db.SeriesWindow{RangeKey: rangeKey})
}
func (f *fakeStore) QueryBatchTargetSeriesWindow(_ context.Context, ids []uuid.UUID, win db.SeriesWindow) (db.BatchSeriesResponse, error) {
	rangeKey := win.RangeKey
	if rangeKey == "" {
		rangeKey = "3h"
	}
	var fromUnix, toUnix *int64
	if win.IsCustom() {
		rangeKey = "custom"
		fSec := win.From.Unix()
		tSec := win.To.Unix()
		fromUnix = &fSec
		toUnix = &tSec
	}
	want := make(map[uuid.UUID]bool, len(ids))
	for _, id := range ids {
		want[id] = true
	}
	out := make(map[string][]db.ProbeSeries)
	for _, tgt := range f.targets {
		if !tgt.Enabled {
			continue
		}
		if len(want) > 0 && !want[tgt.ID] {
			continue
		}
		out[tgt.ID.String()] = []db.ProbeSeries{}
	}
	return db.BatchSeriesResponse{
		Range:     rangeKey,
		BucketSec: 30,
		FromUnix:  fromUnix,
		ToUnix:    toUnix,
		Targets:   out,
	}, nil
}
func (f *fakeStore) ListMTRSnapshots(context.Context, uuid.UUID, int) ([]db.MTRSnapshot, error) {
	return []db.MTRSnapshot{}, nil
}
func (f *fakeStore) ListAlertRules(context.Context) ([]db.AlertRule, error) { return f.alertRules, nil }
func (f *fakeStore) CreateAlertRule(_ context.Context, in db.AlertRuleInput) (db.AlertRule, error) {
	chIDs := in.ChannelIDs
	if chIDs == nil {
		chIDs = []uuid.UUID{}
	}
	r := db.AlertRule{
		ID:              uuid.New(),
		Name:            in.Name,
		TargetID:        in.TargetID,
		GroupID:         in.GroupID,
		Metric:          in.Metric,
		ThresholdValue:  in.ThresholdValue,
		DurationSec:     in.DurationSec,
		QuorumMinProbes: in.QuorumMinProbes,
		CooldownSec:     in.CooldownSec,
		ConfirmSec:      in.ConfirmSec,
		RecoverSec:      in.RecoverSec,
		ChannelIDs:      chIDs,
		Enabled:         in.Enabled,
		CreatedAt:       time.Now().UTC(),
	}
	f.alertRules = append(f.alertRules, r)
	return r, nil
}
func (f *fakeStore) UpdateAlertRule(_ context.Context, id uuid.UUID, in db.AlertRuleInput) (db.AlertRule, error) {
	for i, existing := range f.alertRules {
		if existing.ID == id {
			chIDs := in.ChannelIDs
			if chIDs == nil {
				chIDs = []uuid.UUID{}
			}
			existing.Name = in.Name
			existing.TargetID = in.TargetID
			existing.GroupID = in.GroupID
			existing.Metric = in.Metric
			existing.ThresholdValue = in.ThresholdValue
			existing.DurationSec = in.DurationSec
			existing.QuorumMinProbes = in.QuorumMinProbes
			existing.CooldownSec = in.CooldownSec
			existing.ConfirmSec = in.ConfirmSec
			existing.RecoverSec = in.RecoverSec
			existing.ChannelIDs = chIDs
			existing.Enabled = in.Enabled
			f.alertRules[i] = existing
			return existing, nil
		}
	}
	return db.AlertRule{}, db.ErrNotFound
}
func (f *fakeStore) DeleteAlertRule(context.Context, uuid.UUID) error { return nil }
func (f *fakeStore) ListAlertChannels(context.Context) ([]db.AlertChannel, error) {
	return f.alertChannels, nil
}
func (f *fakeStore) GetAlertChannel(_ context.Context, id uuid.UUID) (db.AlertChannel, error) {
	for _, ch := range f.alertChannels {
		if ch.ID == id {
			return ch, nil
		}
	}
	return db.AlertChannel{}, db.ErrNotFound
}
func (f *fakeStore) CreateAlertChannel(_ context.Context, chType, name string, enc []byte, hint, severityFilter string, enabled bool) (db.AlertChannel, error) {
	if severityFilter == "" {
		severityFilter = "all"
	}
	ch := db.AlertChannel{
		ID:              uuid.New(),
		Type:            chType,
		Name:            name,
		ConfigEncrypted: enc,
		ConfigHint:      hint,
		SeverityFilter:  severityFilter,
		Enabled:         enabled,
		CreatedAt:       time.Now().UTC(),
	}
	f.alertChannels = append(f.alertChannels, ch)
	return ch, nil
}
func (f *fakeStore) UpdateAlertChannel(_ context.Context, id uuid.UUID, name string, enc []byte, hint, severityFilter string, enabled bool) (db.AlertChannel, error) {
	for i, ch := range f.alertChannels {
		if ch.ID == id {
			ch.Name = name
			ch.ConfigEncrypted = enc
			ch.ConfigHint = hint
			if severityFilter != "" {
				ch.SeverityFilter = severityFilter
			}
			ch.Enabled = enabled
			f.alertChannels[i] = ch
			return ch, nil
		}
	}
	return db.AlertChannel{}, db.ErrNotFound
}
func (f *fakeStore) DeleteAlertChannel(context.Context, uuid.UUID) error { return nil }
func (f *fakeStore) ListIncidents(context.Context, int) ([]db.Incident, error) {
	return f.incidents, nil
}
func (f *fakeStore) AcknowledgeIncident(_ context.Context, id uuid.UUID, ackBy string, now time.Time) (db.Incident, error) {
	for i, inc := range f.incidents {
		if inc.ID == id && inc.Status == "open" {
			t := now
			inc.AcknowledgedAt = &t
			inc.AcknowledgedBy = ackBy
			f.incidents[i] = inc
			return inc, nil
		}
	}
	return db.Incident{}, db.ErrNotFound
}
func (f *fakeStore) CloseIncidentByID(_ context.Context, id uuid.UUID, closedBy string, now time.Time) (db.Incident, error) {
	for i, inc := range f.incidents {
		if inc.ID == id && inc.Status == "open" {
			t := now
			inc.Status = "resolved"
			inc.ResolvedAt = &t
			inc.Summary = "Manually closed by " + closedBy
			f.incidents[i] = inc
			return inc, nil
		}
	}
	return db.Incident{}, db.ErrNotFound
}
func (f *fakeStore) ClearIncidents(_ context.Context, includeOpen bool) (int64, error) {
	if includeOpen {
		n := int64(len(f.incidents))
		f.incidents = nil
		return n, nil
	}
	kept := make([]db.Incident, 0, len(f.incidents))
	var deleted int64
	for _, inc := range f.incidents {
		if inc.Status == "resolved" {
			deleted++
			continue
		}
		kept = append(kept, inc)
	}
	f.incidents = kept
	return deleted, nil
}
func (f *fakeStore) CountOpenIncidents(context.Context) (int, error) {
	n := 0
	for _, inc := range f.incidents {
		if inc.Status == "open" {
			n++
		}
	}
	return n, nil
}
func (f *fakeStore) GetSettings(context.Context) (db.SystemSettings, error) {
	return db.SystemSettings{
		RawRetentionDays: 14,
		AggRetentionDays: 730,
		DefaultQuorumMin: 2,
		BrandName:        f.brandName,
		AlertingEnabled:  !f.alertingDisabled,
	}, nil
}
func (f *fakeStore) SetAlertingEnabled(_ context.Context, enabled bool) (db.SystemSettings, error) {
	f.alertingDisabled = !enabled
	return f.GetSettings(context.Background())
}
func (f *fakeStore) UpdateSettingsAndRetention(_ context.Context, rawDays, aggDays, defaultQuorum int, brandName string, alertingEnabled *bool) (db.SystemSettings, error) {
	f.brandName = brandName
	if alertingEnabled != nil {
		f.alertingDisabled = !*alertingEnabled
	}
	return db.SystemSettings{
		RawRetentionDays: rawDays,
		AggRetentionDays: aggDays,
		DefaultQuorumMin: defaultQuorum,
		BrandName:        brandName,
		AlertingEnabled:  !f.alertingDisabled,
	}, nil
}
func (f *fakeStore) ListTVPresets(context.Context) ([]db.TVPreset, error) {
	out := make([]db.TVPreset, 0, len(f.tvPresets))
	for _, p := range f.tvPresets {
		if p.IsDefault {
			out = append(out, p)
		}
	}
	for _, p := range f.tvPresets {
		if !p.IsDefault {
			out = append(out, p)
		}
	}
	return out, nil
}
func (f *fakeStore) CreateTVPreset(_ context.Context, in db.TVPresetInput) (db.TVPreset, error) {
	for _, existing := range f.tvPresets {
		if existing.Slug == in.Slug {
			return db.TVPreset{}, db.ErrConflict
		}
	}
	if in.IsDefault {
		for i := range f.tvPresets {
			f.tvPresets[i].IsDefault = false
		}
	}
	now := time.Now().UTC()
	p := db.TVPreset{
		ID:        uuid.New(),
		Slug:      in.Slug,
		Name:      in.Name,
		Config:    in.Config,
		IsDefault: in.IsDefault,
		CreatedAt: now,
		UpdatedAt: now,
	}
	f.tvPresets = append(f.tvPresets, p)
	return p, nil
}
func (f *fakeStore) UpdateTVPreset(_ context.Context, id uuid.UUID, in db.TVPresetInput) (db.TVPreset, error) {
	for _, existing := range f.tvPresets {
		if existing.ID != id && existing.Slug == in.Slug {
			return db.TVPreset{}, db.ErrConflict
		}
	}
	if in.IsDefault {
		for i := range f.tvPresets {
			if f.tvPresets[i].ID != id {
				f.tvPresets[i].IsDefault = false
			}
		}
	}
	for i, existing := range f.tvPresets {
		if existing.ID == id {
			existing.Slug = in.Slug
			existing.Name = in.Name
			existing.Config = in.Config
			existing.IsDefault = in.IsDefault
			existing.UpdatedAt = time.Now().UTC()
			f.tvPresets[i] = existing
			return existing, nil
		}
	}
	return db.TVPreset{}, db.ErrNotFound
}
func (f *fakeStore) DeleteTVPreset(_ context.Context, id uuid.UUID) error {
	for i, existing := range f.tvPresets {
		if existing.ID == id {
			f.tvPresets = append(f.tvPresets[:i], f.tvPresets[i+1:]...)
			return nil
		}
	}
	return db.ErrNotFound
}

func TestRouterAuthAndTargetValidation(t *testing.T) {
	t.Parallel()
	hash, err := auth.HashPassword("supersecret123")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	store := &fakeStore{adminHash: hash}
	cfg := config.CentralConfig{
		JWTSecret:        "test-jwt-secret-at-least-32-chars!!",
		AppEncryptionKey: "test-aes-secret-at-least-32-chars!!",
		CookieSecure:     "false",
	}
	router := NewRouter(Dependencies{
		Config: cfg,
		Store:  store,
		Cache:  ingest.NewRollingCache(time.Minute),
		AESKey: auth.DeriveAESKey(cfg.AppEncryptionKey),
	})

	// 1. Unauthenticated protected route -> 401
	req := httptest.NewRequest(http.MethodGet, "/api/targets", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("GET /api/targets unauth = %d, want 401", rec.Code)
	}

	// 2. Wrong password -> 401
	badLogin := httptest.NewRequest(http.MethodPost, "/api/auth/login", bytes.NewBufferString(`{"username":"admin","password":"wrong"}`))
	badRec := httptest.NewRecorder()
	router.ServeHTTP(badRec, badLogin)
	if badRec.Code != http.StatusUnauthorized {
		t.Fatalf("bad login = %d, want 401", badRec.Code)
	}

	// 3. Valid login -> 200 + HttpOnly cookie
	goodLogin := httptest.NewRequest(http.MethodPost, "/api/auth/login", bytes.NewBufferString(`{"username":"admin","password":"supersecret123"}`))
	goodRec := httptest.NewRecorder()
	router.ServeHTTP(goodRec, goodLogin)
	if goodRec.Code != http.StatusOK {
		t.Fatalf("good login = %d, want 200", goodRec.Code)
	}
	cookies := goodRec.Result().Cookies()
	if len(cookies) == 0 || !cookies[0].HttpOnly {
		t.Fatalf("expected HttpOnly session cookie")
	}

	// 4. Validation error -> 400 Problem Details
	invalidTarget := httptest.NewRequest(http.MethodPost, "/api/targets", bytes.NewBufferString(`{"name":"Bad","host":"1.1.1.1","probe_type":"tcp","port_or_path":"notaport"}`))
	invalidTarget.AddCookie(cookies[0])
	invRec := httptest.NewRecorder()
	router.ServeHTTP(invRec, invalidTarget)
	if invRec.Code != http.StatusBadRequest {
		t.Fatalf("invalid target = %d, want 400", invRec.Code)
	}

	// 5. Valid target creation -> 201
	validTarget := httptest.NewRequest(http.MethodPost, "/api/targets", bytes.NewBufferString(`{"name":"Cloudflare","host":"1.1.1.1","probe_type":"icmp"}`))
	validTarget.AddCookie(cookies[0])
	valRec := httptest.NewRecorder()
	router.ServeHTTP(valRec, validTarget)
	if valRec.Code != http.StatusCreated {
		t.Fatalf("valid target = %d, want 201 (%s)", valRec.Code, valRec.Body.String())
	}
	var created db.Target
	if err := json.Unmarshal(valRec.Body.Bytes(), &created); err != nil || created.Name != "Cloudflare" {
		t.Fatalf("unexpected target json: %s", valRec.Body.String())
	}

	// 5b. Valid IPv6 target creation (icmp6) -> 201, and IPv4 literal with icmp6 -> 400
	v6Target := httptest.NewRequest(http.MethodPost, "/api/targets", bytes.NewBufferString(`{"name":"Google DNSv6","host":"2001:4860:4860::8888","probe_type":"icmp6"}`))
	v6Target.AddCookie(cookies[0])
	v6Rec := httptest.NewRecorder()
	router.ServeHTTP(v6Rec, v6Target)
	if v6Rec.Code != http.StatusCreated {
		t.Fatalf("valid icmp6 target = %d, want 201 (%s)", v6Rec.Code, v6Rec.Body.String())
	}

	mismatchV6 := httptest.NewRequest(http.MethodPost, "/api/targets", bytes.NewBufferString(`{"name":"Mismatch","host":"8.8.8.8","probe_type":"icmp6"}`))
	mismatchV6.AddCookie(cookies[0])
	mmRec := httptest.NewRecorder()
	router.ServeHTTP(mmRec, mismatchV6)
	if mmRec.Code != http.StatusBadRequest {
		t.Fatalf("ipv4 literal with icmp6 = %d, want 400", mmRec.Code)
	}

	// 6. Seed public presets -> 200
	presetReq := httptest.NewRequest(http.MethodPost, "/api/targets/presets", nil)
	presetReq.AddCookie(cookies[0])
	presetRec := httptest.NewRecorder()
	router.ServeHTTP(presetRec, presetReq)
	if presetRec.Code != http.StatusOK {
		t.Fatalf("presets = %d, want 200 (%s)", presetRec.Code, presetRec.Body.String())
	}
	var seedRes db.SeedResult
	if err := json.Unmarshal(presetRec.Body.Bytes(), &seedRes); err != nil || seedRes.TargetsCreated != 18 {
		t.Fatalf("unexpected seed result: %s", presetRec.Body.String())
	}
}

func TestTVMatrixEndpointAuthGuard(t *testing.T) {
	hash, _ := auth.HashPassword("supersecret123")
	store := &fakeStore{
		adminHash: hash,
		targets: []db.Target{
			{ID: uuid.New(), Name: "Active Core", Host: "1.1.1.1", ProbeType: "icmp", Enabled: true},
			{ID: uuid.New(), Name: "Paused Lab", Host: "192.0.2.1", ProbeType: "icmp", Enabled: false},
		},
	}

	// Case 1: NocTVAllowUnauth = false rejects unauthenticated request
	lockedCfg := config.CentralConfig{
		JWTSecret:        "test-jwt-secret-min-32-characters",
		AppEncryptionKey: "test-enc-secret-min-32-characters",
		NocTVAllowUnauth: false,
	}
	lockedRouter := NewRouter(Dependencies{
		Config: lockedCfg,
		Store:  store,
		Cache:  ingest.NewRollingCache(time.Minute),
		AESKey: auth.DeriveAESKey(lockedCfg.AppEncryptionKey),
	})

	req1 := httptest.NewRequest(http.MethodGet, "/api/tv/matrix", nil)
	rec1 := httptest.NewRecorder()
	lockedRouter.ServeHTTP(rec1, req1)
	if rec1.Code != http.StatusUnauthorized {
		t.Fatalf("GET /api/tv/matrix when NocTVAllowUnauth=false got %d, want 401", rec1.Code)
	}

	// Case 2: NocTVAllowUnauth = true serves read-only snapshot with only enabled targets
	openCfg := lockedCfg
	openCfg.NocTVAllowUnauth = true
	openRouter := NewRouter(Dependencies{
		Config: openCfg,
		Store:  store,
		Cache:  ingest.NewRollingCache(time.Minute),
		AESKey: auth.DeriveAESKey(openCfg.AppEncryptionKey),
	})

	req2 := httptest.NewRequest(http.MethodGet, "/api/tv/matrix", nil)
	rec2 := httptest.NewRecorder()
	openRouter.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusOK {
		t.Fatalf("GET /api/tv/matrix when NocTVAllowUnauth=true got %d, want 200", rec2.Code)
	}
	var payload struct {
		Targets []db.Target `json:"targets"`
		IsAdmin bool        `json:"is_admin"`
	}
	if err := json.Unmarshal(rec2.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode tv matrix failed: %v", err)
	}
	if len(payload.Targets) != 1 || payload.Targets[0].Name != "Active Core" || payload.IsAdmin {
		t.Fatalf("expected only 1 enabled target 'Active Core' and is_admin=false, got %+v", payload)
	}

	// Unauthenticated POST /api/targets/{id}/simulate must be rejected (401) even when NocTVAllowUnauth=true
	simReq := httptest.NewRequest(http.MethodPost, "/api/targets/"+payload.Targets[0].ID.String()+"/simulate", bytes.NewBufferString(`{"mode":"high_latency","duration_sec":30}`))
	simRec := httptest.NewRecorder()
	openRouter.ServeHTTP(simRec, simReq)
	if simRec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated POST /api/targets/{id}/simulate got %d, want 401", simRec.Code)
	}

	// Case 3: /api/tv/series follows the same NocTVAllowUnauth guard & enabled-target filter
	serLockedReq := httptest.NewRequest(http.MethodGet, "/api/tv/series?range=3h", nil)
	serLockedRec := httptest.NewRecorder()
	lockedRouter.ServeHTTP(serLockedRec, serLockedReq)
	if serLockedRec.Code != http.StatusUnauthorized {
		t.Fatalf("GET /api/tv/series when NocTVAllowUnauth=false got %d, want 401", serLockedRec.Code)
	}

	serOpenReq := httptest.NewRequest(http.MethodGet, "/api/tv/series?range=3h&ids="+payload.Targets[0].ID.String()+","+store.targets[1].ID.String(), nil)
	serOpenRec := httptest.NewRecorder()
	openRouter.ServeHTTP(serOpenRec, serOpenReq)
	if serOpenRec.Code != http.StatusOK {
		t.Fatalf("GET /api/tv/series when NocTVAllowUnauth=true got %d, want 200", serOpenRec.Code)
	}
	var batchPayload db.BatchSeriesResponse
	if err := json.Unmarshal(serOpenRec.Body.Bytes(), &batchPayload); err != nil {
		t.Fatalf("decode tv batch series failed: %v", err)
	}
	if batchPayload.Range != "3h" || len(batchPayload.Targets) != 1 {
		t.Fatalf("expected range=3h and only 1 enabled target in /api/tv/series, got %+v", batchPayload)
	}

	// Case 4: /api/tv/targets/{id}/mtr follows NocTVAllowUnauth guard
	mtrLockedReq := httptest.NewRequest(http.MethodGet, "/api/tv/targets/"+payload.Targets[0].ID.String()+"/mtr?limit=5", nil)
	mtrLockedRec := httptest.NewRecorder()
	lockedRouter.ServeHTTP(mtrLockedRec, mtrLockedReq)
	if mtrLockedRec.Code != http.StatusUnauthorized {
		t.Fatalf("GET /api/tv/targets/{id}/mtr when NocTVAllowUnauth=false got %d, want 401", mtrLockedRec.Code)
	}

	mtrOpenReq := httptest.NewRequest(http.MethodGet, "/api/tv/targets/"+payload.Targets[0].ID.String()+"/mtr?limit=5", nil)
	mtrOpenRec := httptest.NewRecorder()
	openRouter.ServeHTTP(mtrOpenRec, mtrOpenReq)
	if mtrOpenRec.Code != http.StatusOK {
		t.Fatalf("GET /api/tv/targets/{id}/mtr when NocTVAllowUnauth=true got %d, want 200", mtrOpenRec.Code)
	}
}

func TestUpdateProbeEndpointAndHubSync(t *testing.T) {
	t.Parallel()
	hash, _ := auth.HashPassword("supersecret123")
	localID := uuid.New()
	store := &fakeStore{
		adminHash: hash,
		probes: []db.Probe{
			{
				ID:            localID,
				Name:          "Local Central Probe",
				LocationLabel: "Central Host",
				ISPAsn:        "LOCAL",
				IsLocal:       true,
				Status:        "online",
			},
		},
	}
	hub := &fakeHub{}
	cfg := config.CentralConfig{
		JWTSecret:        "test-jwt-secret-at-least-32-chars!!",
		AppEncryptionKey: "test-aes-secret-at-least-32-chars!!",
		CookieSecure:     "false",
	}
	router := NewRouter(Dependencies{
		Config: cfg,
		Store:  store,
		Cache:  ingest.NewRollingCache(time.Minute),
		Hub:    hub,
		AESKey: auth.DeriveAESKey(cfg.AppEncryptionKey),
	})

	// Unauthenticated -> 401
	unauthReq := httptest.NewRequest(http.MethodPut, "/api/probes/"+localID.String(), bytes.NewBufferString(`{"name":"Renamed"}`))
	unauthRec := httptest.NewRecorder()
	router.ServeHTTP(unauthRec, unauthReq)
	if unauthRec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated PUT /api/probes/{id} = %d, want 401", unauthRec.Code)
	}

	loginReq := httptest.NewRequest(http.MethodPost, "/api/auth/login", bytes.NewBufferString(`{"username":"admin","password":"supersecret123"}`))
	loginRec := httptest.NewRecorder()
	router.ServeHTTP(loginRec, loginReq)
	if loginRec.Code != http.StatusOK {
		t.Fatalf("login failed: %d", loginRec.Code)
	}
	sessionCookie := loginRec.Result().Cookies()[0]

	// Short/empty name -> 400
	badReq := httptest.NewRequest(http.MethodPut, "/api/probes/"+localID.String(), bytes.NewBufferString(`{"name":"A"}`))
	badReq.AddCookie(sessionCookie)
	badRec := httptest.NewRecorder()
	router.ServeHTTP(badRec, badReq)
	if badRec.Code != http.StatusBadRequest {
		t.Fatalf("short probe name = %d, want 400", badRec.Code)
	}

	// Non-existent ID -> 404
	missingReq := httptest.NewRequest(http.MethodPut, "/api/probes/"+uuid.NewString(), bytes.NewBufferString(`{"name":"Remote-SGP"}`))
	missingReq.AddCookie(sessionCookie)
	missingRec := httptest.NewRecorder()
	router.ServeHTTP(missingRec, missingReq)
	if missingRec.Code != http.StatusNotFound {
		t.Fatalf("missing probe = %d, want 404", missingRec.Code)
	}

	// Valid update of local probe -> 200 and updates Hub metadata
	okReq := httptest.NewRequest(http.MethodPut, "/api/probes/"+localID.String(), bytes.NewBufferString(`{"name":"  DC-Jakarta-01  ","location_label":" Cyber1 Jakarta ","isp_asn":"AS7713"}`))
	okReq.AddCookie(sessionCookie)
	okRec := httptest.NewRecorder()
	router.ServeHTTP(okRec, okReq)
	if okRec.Code != http.StatusOK {
		t.Fatalf("PUT /api/probes/{id} = %d (%s), want 200", okRec.Code, okRec.Body.String())
	}
	var updated db.Probe
	if err := json.Unmarshal(okRec.Body.Bytes(), &updated); err != nil {
		t.Fatalf("decode updated probe failed: %v", err)
	}
	if updated.Name != "DC-Jakarta-01" || updated.LocationLabel != "Cyber1 Jakarta" || updated.ISPAsn != "AS7713" || !updated.IsLocal {
		t.Fatalf("unexpected updated probe: %+v", updated)
	}
	if len(hub.updatedProbes) != 1 || hub.updatedProbes[0].Name != "DC-Jakarta-01" {
		t.Fatalf("expected Hub.UpdateProbeMeta called with DC-Jakarta-01, got %+v", hub.updatedProbes)
	}
}

func TestTargetSeriesEnrichesWarnThreshold(t *testing.T) {
	pwHash, _ := auth.HashPassword("supersecret123")
	probeID := uuid.New()
	targetID := uuid.New()
	store := &fakeStore{
		adminHash: pwHash,
		probes: []db.Probe{
			{ID: probeID, Name: "Probe-SGP", LocationLabel: "Singapore"},
		},
		targets: []db.Target{
			{
				ID:              targetID,
				Name:            "Google DNS",
				Host:            "8.8.8.8",
				Enabled:         true,
				AssignAllProbes: true,
				LatencyWarnMs:   25,
				TimeoutMs:       1000,
			},
		},
	}
	cfg := config.CentralConfig{
		JWTSecret:        "test-jwt-secret-at-least-32-chars!!",
		AppEncryptionKey: "test-aes-secret-at-least-32-chars!!",
		CookieSecure:     "false",
	}
	router := NewRouter(Dependencies{
		Config: cfg,
		Store:  store,
		Cache:  ingest.NewRollingCache(time.Minute),
		Hub:    &fakeHub{},
		AESKey: auth.DeriveAESKey(cfg.AppEncryptionKey),
	})

	loginReq := httptest.NewRequest(http.MethodPost, "/api/auth/login", bytes.NewBufferString(`{"username":"admin","password":"supersecret123"}`))
	loginRec := httptest.NewRecorder()
	router.ServeHTTP(loginRec, loginReq)
	sessionCookie := loginRec.Result().Cookies()[0]

	req := httptest.NewRequest(http.MethodGet, "/api/targets/"+targetID.String()+"/series?range=5m", nil)
	req.AddCookie(sessionCookie)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/targets/{id}/series = %d, want 200", rec.Code)
	}
	var out db.TargetSeriesResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode target series failed: %v", err)
	}
	if len(out.Series) != 1 || out.Series[0].WarnMs == nil || *out.Series[0].WarnMs != 25 {
		t.Fatalf("expected series[0].warn_ms = 25, got %+v", out.Series)
	}
}

func TestTargetPerProbeValidationAndDeleteGuard(t *testing.T) {
	pwHash, _ := auth.HashPassword("supersecret123")
	probeA := uuid.New()
	probeB := uuid.New()
	store := &fakeStore{
		adminHash: pwHash,
		probes: []db.Probe{
			{ID: probeA, Name: "Probe-JKT"},
			{ID: probeB, Name: "Probe-SGP"},
		},
	}
	cfg := config.CentralConfig{
		JWTSecret:        "test-jwt-secret-at-least-32-chars!!",
		AppEncryptionKey: "test-aes-secret-at-least-32-chars!!",
		CookieSecure:     "false",
	}
	router := NewRouter(Dependencies{
		Config: cfg,
		Store:  store,
		Cache:  ingest.NewRollingCache(time.Minute),
		Hub:    &fakeHub{},
		AESKey: auth.DeriveAESKey(cfg.AppEncryptionKey),
	})

	loginReq := httptest.NewRequest(http.MethodPost, "/api/auth/login", bytes.NewBufferString(`{"username":"admin","password":"supersecret123"}`))
	loginRec := httptest.NewRecorder()
	router.ServeHTTP(loginRec, loginReq)
	sessionCookie := loginRec.Result().Cookies()[0]

	// 1. assign_all_probes=false with empty probe_ids -> 400 validation_error
	emptyReq := httptest.NewRequest(http.MethodPost, "/api/targets", bytes.NewBufferString(`{"name":"Edge-Only","host":"1.1.1.1","probe_type":"icmp","assign_all_probes":false,"probe_ids":[]}`))
	emptyReq.AddCookie(sessionCookie)
	emptyRec := httptest.NewRecorder()
	router.ServeHTTP(emptyRec, emptyReq)
	if emptyRec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 when probe_ids empty, got %d (%s)", emptyRec.Code, emptyRec.Body.String())
	}

	// 2. Deduplicates probe_ids and prunes overrides for unassigned probes
	createBody := `{"name":"Branch-GW","host":"10.20.30.1","probe_type":"icmp","assign_all_probes":false,"probe_ids":["` + probeA.String() + `","` + probeA.String() + `"],"probe_latency_overrides":{"` + probeA.String() + `":45,"` + probeB.String() + `":90}}`
	createReq := httptest.NewRequest(http.MethodPost, "/api/targets", bytes.NewBufferString(createBody))
	createReq.AddCookie(sessionCookie)
	createRec := httptest.NewRecorder()
	router.ServeHTTP(createRec, createReq)
	if createRec.Code != http.StatusCreated {
		t.Fatalf("create target = %d (%s), want 201", createRec.Code, createRec.Body.String())
	}
	var created db.Target
	if err := json.Unmarshal(createRec.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode created target: %v", err)
	}
	if len(created.ProbeIDs) != 1 || created.ProbeIDs[0] != probeA {
		t.Fatalf("expected deduplicated probe_ids [%s], got %+v", probeA, created.ProbeIDs)
	}
	if _, hasB := created.ProbeLatencyOverrides[probeB.String()]; hasB {
		t.Fatalf("expected override for unassigned probeB to be pruned, got %+v", created.ProbeLatencyOverrides)
	}
	if created.ProbeLatencyOverrides[probeA.String()] != 45 {
		t.Fatalf("expected override for probeA = 45, got %+v", created.ProbeLatencyOverrides)
	}

	// 3. Updating target with assign_all_probes=false & empty probe_ids -> 400
	updEmptyReq := httptest.NewRequest(http.MethodPut, "/api/targets/"+created.ID.String(), bytes.NewBufferString(`{"name":"Branch-GW","host":"10.20.30.1","probe_type":"icmp","assign_all_probes":false,"probe_ids":[]}`))
	updEmptyReq.AddCookie(sessionCookie)
	updEmptyRec := httptest.NewRecorder()
	router.ServeHTTP(updEmptyRec, updEmptyReq)
	if updEmptyRec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 on update with empty probe_ids, got %d", updEmptyRec.Code)
	}

	// 4. Deleting probeA while it is the sole assigned probe of active target -> 409 Conflict
	delBlockedReq := httptest.NewRequest(http.MethodDelete, "/api/probes/"+probeA.String(), nil)
	delBlockedReq.AddCookie(sessionCookie)
	delBlockedRec := httptest.NewRecorder()
	router.ServeHTTP(delBlockedRec, delBlockedReq)
	if delBlockedRec.Code != http.StatusConflict {
		t.Fatalf("expected 409 Conflict deleting sole active probe, got %d (%s)", delBlockedRec.Code, delBlockedRec.Body.String())
	}
	if !bytes.Contains(delBlockedRec.Body.Bytes(), []byte("Branch-GW")) {
		t.Fatalf("expected conflict message to mention Branch-GW, got %s", delBlockedRec.Body.String())
	}

	// 5. Deleting unassigned probeB succeeds -> 204
	delOkReq := httptest.NewRequest(http.MethodDelete, "/api/probes/"+probeB.String(), nil)
	delOkReq.AddCookie(sessionCookie)
	delOkRec := httptest.NewRecorder()
	router.ServeHTTP(delOkRec, delOkReq)
	if delOkRec.Code != http.StatusNoContent {
		t.Fatalf("expected 204 deleting unassigned probeB, got %d", delOkRec.Code)
	}
}

func TestTelegramAlertChannelWithThreadID(t *testing.T) {
	pwHash, _ := auth.HashPassword("supersecret123")
	store := &fakeStore{adminHash: pwHash}
	cfg := config.CentralConfig{
		JWTSecret:        "test-jwt-secret-at-least-32-chars!!",
		AppEncryptionKey: "test-aes-secret-at-least-32-chars!!",
		CookieSecure:     "false",
	}
	router := NewRouter(Dependencies{
		Config: cfg,
		Store:  store,
		Cache:  ingest.NewRollingCache(time.Minute),
		Hub:    &fakeHub{},
		AESKey: auth.DeriveAESKey(cfg.AppEncryptionKey),
	})

	loginReq := httptest.NewRequest(http.MethodPost, "/api/auth/login", bytes.NewBufferString(`{"username":"admin","password":"supersecret123"}`))
	loginRec := httptest.NewRecorder()
	router.ServeHTTP(loginRec, loginReq)
	sessionCookie := loginRec.Result().Cookies()[0]

	// Invalid thread_id -> 400
	badReq := httptest.NewRequest(http.MethodPost, "/api/alerts/channels", bytes.NewBufferString(`{"type":"telegram","name":"NOC Topic","bot_token":"123:ABC","chat_id":"-1001234","thread_id":-5}`))
	badReq.AddCookie(sessionCookie)
	badRec := httptest.NewRecorder()
	router.ServeHTTP(badRec, badReq)
	if badRec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for negative thread_id, got %d (%s)", badRec.Code, badRec.Body.String())
	}

	// Valid thread_id -> 201 and hint includes thread:<id>
	okReq := httptest.NewRequest(http.MethodPost, "/api/alerts/channels", bytes.NewBufferString(`{"type":"telegram","name":"NOC Topic","bot_token":"123:ABC","chat_id":"-1001234","thread_id":7788}`))
	okReq.AddCookie(sessionCookie)
	okRec := httptest.NewRecorder()
	router.ServeHTTP(okRec, okReq)
	if okRec.Code != http.StatusCreated {
		t.Fatalf("expected 201 creating telegram channel with thread_id, got %d (%s)", okRec.Code, okRec.Body.String())
	}
	var ch db.AlertChannel
	if err := json.Unmarshal(okRec.Body.Bytes(), &ch); err != nil {
		t.Fatalf("decode created channel: %v", err)
	}
	if ch.ConfigHint != "chat:-1001234 · thread:7788" {
		t.Fatalf("unexpected config_hint: %q", ch.ConfigHint)
	}
	plain, err := auth.DecryptAESGCM(auth.DeriveAESKey(cfg.AppEncryptionKey), store.alertChannels[0].ConfigEncrypted)
	if err != nil {
		t.Fatalf("decrypt secret: %v", err)
	}
	var sec alerts.ChannelSecret
	if err := json.Unmarshal(plain, &sec); err != nil {
		t.Fatalf("unmarshal secret: %v", err)
	}
	if sec.ThreadID != 7788 {
		t.Fatalf("expected stored ThreadID=7788, got %d", sec.ThreadID)
	}

	// Update channel: toggle disabled while preserving bot_token/chat_id/thread_id
	toggleReq := httptest.NewRequest(http.MethodPut, "/api/alerts/channels/"+ch.ID.String(), bytes.NewBufferString(`{"enabled":false}`))
	toggleReq.AddCookie(sessionCookie)
	toggleRec := httptest.NewRecorder()
	router.ServeHTTP(toggleRec, toggleReq)
	if toggleRec.Code != http.StatusOK {
		t.Fatalf("expected 200 toggling channel, got %d (%s)", toggleRec.Code, toggleRec.Body.String())
	}
	var toggled db.AlertChannel
	if err := json.Unmarshal(toggleRec.Body.Bytes(), &toggled); err != nil {
		t.Fatalf("decode toggled channel: %v", err)
	}
	if toggled.Enabled || toggled.Name != "NOC Topic" || toggled.ConfigHint != "chat:-1001234 · thread:7788" {
		t.Fatalf("expected credentials/hint preserved on toggle, got %+v", toggled)
	}

	// Update channel: clear thread_id and rename while keeping bot_token empty
	updReq := httptest.NewRequest(http.MethodPut, "/api/alerts/channels/"+ch.ID.String(), bytes.NewBufferString(`{"name":"NOC Main","chat_id":"-100999","thread_id":null,"enabled":true}`))
	updReq.AddCookie(sessionCookie)
	updRec := httptest.NewRecorder()
	router.ServeHTTP(updRec, updReq)
	if updRec.Code != http.StatusOK {
		t.Fatalf("expected 200 updating channel, got %d (%s)", updRec.Code, updRec.Body.String())
	}
	var updated db.AlertChannel
	if err := json.Unmarshal(updRec.Body.Bytes(), &updated); err != nil {
		t.Fatalf("decode updated channel: %v", err)
	}
	if !updated.Enabled || updated.Name != "NOC Main" || updated.ConfigHint != "chat:-100999" {
		t.Fatalf("unexpected updated channel: %+v", updated)
	}

	// Create Global alert rule (target_id=null, group_id=null) with cooldown_sec=0 & channel_ids routing
	rulePayload := `{"name":"Global Packet Loss","metric":"loss_pct","threshold_value":20,"duration_sec":30,"quorum_min_probes":1,"cooldown_sec":0,"channel_ids":["` + ch.ID.String() + `"]}`
	ruleReq := httptest.NewRequest(http.MethodPost, "/api/alerts/rules", bytes.NewBufferString(rulePayload))
	ruleReq.AddCookie(sessionCookie)
	ruleRec := httptest.NewRecorder()
	router.ServeHTTP(ruleRec, ruleReq)
	if ruleRec.Code != http.StatusCreated {
		t.Fatalf("expected 201 creating global rule, got %d (%s)", ruleRec.Code, ruleRec.Body.String())
	}
	var createdRule db.AlertRule
	if err := json.Unmarshal(ruleRec.Body.Bytes(), &createdRule); err != nil {
		t.Fatalf("decode global rule: %v", err)
	}
	if createdRule.TargetID != nil || createdRule.GroupID != nil || createdRule.CooldownSec != 0 || createdRule.ConfirmSec != 0 || createdRule.RecoverSec != 45 || len(createdRule.ChannelIDs) != 1 || createdRule.ChannelIDs[0] != ch.ID {
		t.Fatalf("unexpected global rule defaults: %+v", createdRule)
	}

	// Update rule with custom hold-down timers (confirm_sec=90, recover_sec=0)
	updRulePayload := `{"name":"Global Packet Loss","metric":"loss_pct","threshold_value":20,"duration_sec":30,"quorum_min_probes":1,"cooldown_sec":0,"confirm_sec":90,"recover_sec":0,"channel_ids":["` + ch.ID.String() + `"]}`
	updRuleReq := httptest.NewRequest(http.MethodPut, "/api/alerts/rules/"+createdRule.ID.String(), bytes.NewBufferString(updRulePayload))
	updRuleReq.AddCookie(sessionCookie)
	updRuleRec := httptest.NewRecorder()
	router.ServeHTTP(updRuleRec, updRuleReq)
	if updRuleRec.Code != http.StatusOK {
		t.Fatalf("expected 200 updating rule timers, got %d (%s)", updRuleRec.Code, updRuleRec.Body.String())
	}
	var updatedRule db.AlertRule
	if err := json.Unmarshal(updRuleRec.Body.Bytes(), &updatedRule); err != nil {
		t.Fatalf("decode updated rule: %v", err)
	}
	if updatedRule.ConfirmSec != 90 || updatedRule.RecoverSec != 0 {
		t.Fatalf("expected confirm_sec=90 recover_sec=0, got %+v", updatedRule)
	}

	// Channel severity_filter: invalid value -> 400, valid 'critical' -> 200
	badFilterReq := httptest.NewRequest(http.MethodPut, "/api/alerts/channels/"+ch.ID.String(), bytes.NewBufferString(`{"severity_filter":"invalid_level"}`))
	badFilterReq.AddCookie(sessionCookie)
	badFilterRec := httptest.NewRecorder()
	router.ServeHTTP(badFilterRec, badFilterReq)
	if badFilterRec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid severity_filter, got %d", badFilterRec.Code)
	}

	critFilterReq := httptest.NewRequest(http.MethodPut, "/api/alerts/channels/"+ch.ID.String(), bytes.NewBufferString(`{"severity_filter":"critical"}`))
	critFilterReq.AddCookie(sessionCookie)
	critFilterRec := httptest.NewRecorder()
	router.ServeHTTP(critFilterRec, critFilterReq)
	if critFilterRec.Code != http.StatusOK {
		t.Fatalf("expected 200 updating severity_filter=critical, got %d (%s)", critFilterRec.Code, critFilterRec.Body.String())
	}
	var critCh db.AlertChannel
	if err := json.Unmarshal(critFilterRec.Body.Bytes(), &critCh); err != nil || critCh.SeverityFilter != "critical" {
		t.Fatalf("expected severity_filter=critical, got %+v (err=%v)", critCh, err)
	}

	// Incident Acknowledge & Target Maintenance Mute endpoints
	targetID := uuid.New()
	store.targets = append(store.targets, db.Target{ID: targetID, Name: "Core-Link", Host: "10.0.0.1", ProbeType: "icmp", Enabled: true})
	incID := uuid.New()
	store.incidents = append(store.incidents, db.Incident{
		ID:        incID,
		RuleID:    createdRule.ID,
		TargetID:  &targetID,
		Status:    "open",
		Severity:  "critical",
		StartedAt: time.Now().UTC(),
	})

	ackReq := httptest.NewRequest(http.MethodPost, "/api/alerts/incidents/"+incID.String()+"/ack", nil)
	ackReq.AddCookie(sessionCookie)
	ackRec := httptest.NewRecorder()
	router.ServeHTTP(ackRec, ackReq)
	if ackRec.Code != http.StatusOK {
		t.Fatalf("expected 200 acknowledging open incident, got %d (%s)", ackRec.Code, ackRec.Body.String())
	}
	var ackedInc db.Incident
	if err := json.Unmarshal(ackRec.Body.Bytes(), &ackedInc); err != nil || ackedInc.AcknowledgedAt == nil || ackedInc.AcknowledgedBy != "admin" {
		t.Fatalf("expected acknowledged_at and acknowledged_by=admin, got %+v", ackedInc)
	}

	muteReq := httptest.NewRequest(http.MethodPost, "/api/targets/"+targetID.String()+"/mute", bytes.NewBufferString(`{"duration":"1h"}`))
	muteReq.AddCookie(sessionCookie)
	muteRec := httptest.NewRecorder()
	router.ServeHTTP(muteRec, muteReq)
	if muteRec.Code != http.StatusOK {
		t.Fatalf("expected 200 muting target, got %d (%s)", muteRec.Code, muteRec.Body.String())
	}
	var mutedTarget db.Target
	if err := json.Unmarshal(muteRec.Body.Bytes(), &mutedTarget); err != nil || mutedTarget.MutedUntil == nil {
		t.Fatalf("expected muted_until set on target, got %+v", mutedTarget)
	}

	unmuteReq := httptest.NewRequest(http.MethodPost, "/api/targets/"+targetID.String()+"/mute", bytes.NewBufferString(`{"duration":"off"}`))
	unmuteReq.AddCookie(sessionCookie)
	unmuteRec := httptest.NewRecorder()
	router.ServeHTTP(unmuteRec, unmuteReq)
	if unmuteRec.Code != http.StatusOK {
		t.Fatalf("expected 200 unmuting target, got %d (%s)", unmuteRec.Code, unmuteRec.Body.String())
	}
	var unmutedTarget db.Target
	if err := json.Unmarshal(unmuteRec.Body.Bytes(), &unmutedTarget); err != nil || unmutedTarget.MutedUntil != nil {
		t.Fatalf("expected muted_until cleared on target, got %+v", unmutedTarget)
	}

	// Default target interval_sec when omitted should be 5s, and latency_p95 threshold_value=0 (Auto Best-Path) must be accepted
	tDefReq := httptest.NewRequest(http.MethodPost, "/api/targets", bytes.NewBufferString(`{"name":"Default Interval Node","host":"1.0.0.1","probe_type":"icmp","assign_all_probes":true}`))
	tDefReq.AddCookie(sessionCookie)
	tDefRec := httptest.NewRecorder()
	router.ServeHTTP(tDefRec, tDefReq)
	if tDefRec.Code != http.StatusCreated {
		t.Fatalf("expected 201 creating target with omitted interval_sec, got %d (%s)", tDefRec.Code, tDefRec.Body.String())
	}
	var defTarget db.Target
	if err := json.Unmarshal(tDefRec.Body.Bytes(), &defTarget); err != nil {
		t.Fatalf("decode default interval target: %v", err)
	}
	if defTarget.IntervalSec != 5 {
		t.Fatalf("expected omitted interval_sec default to 5, got %d", defTarget.IntervalSec)
	}

	autoRttReq := httptest.NewRequest(http.MethodPost, "/api/alerts/rules", bytes.NewBufferString(`{"name":"Auto BestPath RTT","target_id":"`+defTarget.ID.String()+`","metric":"latency_p95","threshold_value":0,"duration_sec":30,"quorum_min_probes":1,"cooldown_sec":0}`))
	autoRttReq.AddCookie(sessionCookie)
	autoRttRec := httptest.NewRecorder()
	router.ServeHTTP(autoRttRec, autoRttReq)
	if autoRttRec.Code != http.StatusCreated {
		t.Fatalf("expected 201 creating latency_p95 threshold_value=0 rule, got %d (%s)", autoRttRec.Code, autoRttRec.Body.String())
	}
}

func TestAlertingControlsAndTargetOptIn(t *testing.T) {
	t.Parallel()
	pwHash, _ := auth.HashPassword("supersecret123")
	store := &fakeStore{adminHash: pwHash}
	hub := &fakeHub{}
	cfg := config.CentralConfig{
		JWTSecret:        "test-jwt-secret-at-least-32-chars!!",
		AppEncryptionKey: "test-aes-secret-at-least-32-chars!!",
		CookieSecure:     "false",
	}
	router := NewRouter(Dependencies{
		Config: cfg,
		Store:  store,
		Cache:  ingest.NewRollingCache(time.Minute),
		Hub:    hub,
		AESKey: auth.DeriveAESKey(cfg.AppEncryptionKey),
	})

	loginReq := httptest.NewRequest(http.MethodPost, "/api/auth/login", bytes.NewBufferString(`{"username":"admin","password":"supersecret123"}`))
	loginRec := httptest.NewRecorder()
	router.ServeHTTP(loginRec, loginReq)
	sessionCookie := loginRec.Result().Cookies()[0]

	// 1. Toggle global alerting status OFF -> 200, broadcasts incident_update, preserved by PUT /api/settings when omitted
	offReq := httptest.NewRequest(http.MethodPut, "/api/alerts/status", bytes.NewBufferString(`{"alerting_enabled":false}`))
	offReq.AddCookie(sessionCookie)
	offRec := httptest.NewRecorder()
	router.ServeHTTP(offRec, offReq)
	if offRec.Code != http.StatusOK {
		t.Fatalf("expected 200 turning alerting OFF, got %d (%s)", offRec.Code, offRec.Body.String())
	}
	var st db.SystemSettings
	if err := json.Unmarshal(offRec.Body.Bytes(), &st); err != nil || st.AlertingEnabled {
		t.Fatalf("expected alerting_enabled=false, got %+v err=%v", st, err)
	}

	updSetReq := httptest.NewRequest(http.MethodPut, "/api/settings", bytes.NewBufferString(`{"raw_retention_days":14,"agg_retention_days":365,"default_quorum_min":2,"brand_name":"NOC Lab"}`))
	updSetReq.AddCookie(sessionCookie)
	updSetRec := httptest.NewRecorder()
	router.ServeHTTP(updSetRec, updSetReq)
	if updSetRec.Code != http.StatusOK {
		t.Fatalf("expected 200 updating settings, got %d (%s)", updSetRec.Code, updSetRec.Body.String())
	}
	if err := json.Unmarshal(updSetRec.Body.Bytes(), &st); err != nil || st.AlertingEnabled {
		t.Fatalf("expected omitted alerting_enabled in PUT /api/settings to preserve false, got %+v err=%v", st, err)
	}

	// Bad payload on PUT /api/alerts/status -> 400
	badStatusReq := httptest.NewRequest(http.MethodPut, "/api/alerts/status", bytes.NewBufferString(`{}`))
	badStatusReq.AddCookie(sessionCookie)
	badStatusRec := httptest.NewRecorder()
	router.ServeHTTP(badStatusRec, badStatusReq)
	if badStatusRec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 when alerting_enabled missing, got %d", badStatusRec.Code)
	}

	// 2. Create Monitoring-Only target (alerts_enabled=false) & default target (alerts_enabled=true)
	monReq := httptest.NewRequest(http.MethodPost, "/api/targets", bytes.NewBufferString(`{"name":"Monitor Only Node","host":"1.1.1.1","probe_type":"icmp","alerts_enabled":false,"assign_all_probes":true}`))
	monReq.AddCookie(sessionCookie)
	monRec := httptest.NewRecorder()
	router.ServeHTTP(monRec, monReq)
	if monRec.Code != http.StatusCreated {
		t.Fatalf("expected 201 creating monitor-only target, got %d (%s)", monRec.Code, monRec.Body.String())
	}
	var monTarget db.Target
	if err := json.Unmarshal(monRec.Body.Bytes(), &monTarget); err != nil || monTarget.AlertsEnabled {
		t.Fatalf("expected alerts_enabled=false, got %+v err=%v", monTarget, err)
	}

	defReq := httptest.NewRequest(http.MethodPost, "/api/targets", bytes.NewBufferString(`{"name":"Alerted Node","host":"8.8.8.8","probe_type":"icmp","assign_all_probes":true}`))
	defReq.AddCookie(sessionCookie)
	defRec := httptest.NewRecorder()
	router.ServeHTTP(defRec, defReq)
	if defRec.Code != http.StatusCreated {
		t.Fatalf("expected 201 creating default alerted target, got %d (%s)", defRec.Code, defRec.Body.String())
	}
	var alertedTarget db.Target
	if err := json.Unmarshal(defRec.Body.Bytes(), &alertedTarget); err != nil || !alertedTarget.AlertsEnabled {
		t.Fatalf("expected default alerts_enabled=true, got %+v err=%v", alertedTarget, err)
	}

	// 3. Seed open incidents, manually Close one via POST /api/alerts/incidents/{id}/close, auto-close another via PUT /api/targets/{id}
	inc1 := uuid.New()
	inc2 := uuid.New()
	store.incidents = []db.Incident{
		{ID: inc1, RuleID: uuid.New(), TargetID: &alertedTarget.ID, Status: "open", Severity: "critical", StartedAt: time.Now().UTC()},
		{ID: inc2, RuleID: uuid.New(), TargetID: &alertedTarget.ID, Status: "open", Severity: "warn", StartedAt: time.Now().UTC()},
	}

	closeReq := httptest.NewRequest(http.MethodPost, "/api/alerts/incidents/"+inc1.String()+"/close", nil)
	closeReq.AddCookie(sessionCookie)
	closeRec := httptest.NewRecorder()
	router.ServeHTTP(closeRec, closeReq)
	if closeRec.Code != http.StatusOK {
		t.Fatalf("expected 200 closing open incident, got %d (%s)", closeRec.Code, closeRec.Body.String())
	}
	var closedInc db.Incident
	if err := json.Unmarshal(closeRec.Body.Bytes(), &closedInc); err != nil || closedInc.Status != "resolved" || closedInc.ResolvedAt == nil {
		t.Fatalf("expected closed incident status=resolved, got %+v err=%v", closedInc, err)
	}

	// Closing an already resolved incident -> 404
	closeAgainReq := httptest.NewRequest(http.MethodPost, "/api/alerts/incidents/"+inc1.String()+"/close", nil)
	closeAgainReq.AddCookie(sessionCookie)
	closeAgainRec := httptest.NewRecorder()
	router.ServeHTTP(closeAgainRec, closeAgainReq)
	if closeAgainRec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 closing already-resolved incident, got %d", closeAgainRec.Code)
	}

	// Clear resolved only -> removes inc1, leaves open inc2
	clearResReq := httptest.NewRequest(http.MethodDelete, "/api/alerts/incidents?scope=resolved", nil)
	clearResReq.AddCookie(sessionCookie)
	clearResRec := httptest.NewRecorder()
	router.ServeHTTP(clearResRec, clearResReq)
	if clearResRec.Code != http.StatusOK {
		t.Fatalf("expected 200 clearing resolved incidents, got %d (%s)", clearResRec.Code, clearResRec.Body.String())
	}
	if len(store.incidents) != 1 || store.incidents[0].ID != inc2 {
		t.Fatalf("expected only open inc2 remaining, got %+v", store.incidents)
	}

	// Invalid scope -> 400
	badScopeReq := httptest.NewRequest(http.MethodDelete, "/api/alerts/incidents?scope=invalid", nil)
	badScopeReq.AddCookie(sessionCookie)
	badScopeRec := httptest.NewRecorder()
	router.ServeHTTP(badScopeRec, badScopeReq)
	if badScopeRec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid clear scope, got %d", badScopeRec.Code)
	}

	// Update target to alerts_enabled=false -> auto-closes inc2 and broadcasts incident_update
	beforeEvents := len(hub.broadcastEvents)
	updTargetReq := httptest.NewRequest(http.MethodPut, "/api/targets/"+alertedTarget.ID.String(), bytes.NewBufferString(`{"name":"Alerted Node","host":"8.8.8.8","probe_type":"icmp","alerts_enabled":false,"assign_all_probes":true}`))
	updTargetReq.AddCookie(sessionCookie)
	updTargetRec := httptest.NewRecorder()
	router.ServeHTTP(updTargetRec, updTargetReq)
	if updTargetRec.Code != http.StatusOK {
		t.Fatalf("expected 200 updating target to monitor only, got %d (%s)", updTargetRec.Code, updTargetRec.Body.String())
	}
	if store.incidents[0].Status != "resolved" || len(hub.broadcastEvents) <= beforeEvents {
		t.Fatalf("expected inc2 auto-closed and incident_update broadcast, got inc=%+v events=%d->%d", store.incidents[0], beforeEvents, len(hub.broadcastEvents))
	}

	// Clear all -> empties history completely
	clearAllReq := httptest.NewRequest(http.MethodDelete, "/api/alerts/incidents?scope=all", nil)
	clearAllReq.AddCookie(sessionCookie)
	clearAllRec := httptest.NewRecorder()
	router.ServeHTTP(clearAllRec, clearAllReq)
	if clearAllRec.Code != http.StatusOK || len(store.incidents) != 0 {
		t.Fatalf("expected 200 and 0 incidents after scope=all, got code=%d len=%d", clearAllRec.Code, len(store.incidents))
	}
}

func TestAlertChannelTestMessageIncludesFleetSummary(t *testing.T) {
	t.Parallel()
	var gotText string
	tgSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		gotText, _ = body["text"].(string)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true,"result":{"message_id":101}}`))
	}))
	defer tgSrv.Close()

	pwHash, _ := auth.HashPassword("supersecret123")
	cfg := config.CentralConfig{
		JWTSecret:        "test-jwt-secret-at-least-32-chars!!",
		AppEncryptionKey: "test-aes-secret-at-least-32-chars!!",
		CookieSecure:     "false",
	}
	aesKey := auth.DeriveAESKey(cfg.AppEncryptionKey)
	enc, _ := auth.EncryptAESGCM(aesKey, []byte(`{"bot_token":"123:ABC","chat_id":"-1009"}`))
	chID := uuid.New()
	store := &fakeStore{
		adminHash: pwHash,
		probes: []db.Probe{
			{ID: uuid.New(), Name: "Localhost", Status: "online"},
		},
		targets: []db.Target{
			{ID: uuid.New(), Name: "CF", Host: "1.1.1.1", Enabled: true, AlertsEnabled: true},
		},
		alertChannels: []db.AlertChannel{
			{ID: chID, Type: "telegram", Name: "LAB VI", ConfigEncrypted: enc, SeverityFilter: "all", Enabled: true},
		},
	}
	router := NewRouter(Dependencies{
		Config:   cfg,
		Store:    store,
		Cache:    ingest.NewRollingCache(time.Minute),
		Hub:      &fakeHub{},
		Notifier: alerts.NewNotifierWithHTTP(tgSrv.Client(), tgSrv.URL),
		AESKey:   aesKey,
	})

	loginReq := httptest.NewRequest(http.MethodPost, "/api/auth/login", bytes.NewBufferString(`{"username":"admin","password":"supersecret123"}`))
	loginRec := httptest.NewRecorder()
	router.ServeHTTP(loginRec, loginReq)
	sessionCookie := loginRec.Result().Cookies()[0]

	testReq := httptest.NewRequest(http.MethodPost, "/api/alerts/channels/"+chID.String()+"/test", nil)
	testReq.AddCookie(sessionCookie)
	testRec := httptest.NewRecorder()
	router.ServeHTTP(testRec, testReq)
	if testRec.Code != http.StatusOK {
		t.Fatalf("expected 200 sending test notification, got %d (%s)", testRec.Code, testRec.Body.String())
	}
	if !bytes.Contains([]byte(gotText), []byte("Connected · Alerting ON")) ||
		!bytes.Contains([]byte(gotText), []byte("1/1 probe online · 1 active targets (0 open incidents)")) ||
		!bytes.Contains([]byte(gotText), []byte("LAB VI (All severities)")) {
		t.Fatalf("unexpected [TEST] fleet message:\n%s", gotText)
	}
}

func TestTVSecurityHardeningKioskTokenAndPresets(t *testing.T) {
	t.Parallel()
	pwHash, _ := auth.HashPassword("supersecret123")
	targetID := uuid.New()
	store := &fakeStore{
		adminHash: pwHash,
		targets: []db.Target{
			{ID: targetID, Name: "Core-1", Host: "1.1.1.1", ProbeType: "icmp", Enabled: true, AlertsEnabled: true, AssignAllProbes: true},
		},
	}

	// 1. Mode LAN Unauth (no kiosk token): TV MTR rate-limited to 1x per 30s; simulate requires Admin
	openCfg := config.CentralConfig{
		JWTSecret:        "test-jwt-secret-at-least-32-chars!!",
		AppEncryptionKey: "test-aes-secret-at-least-32-chars!!",
		CookieSecure:     "false",
		NocTVAllowUnauth: true,
	}
	openRouter := NewRouter(Dependencies{
		Config: openCfg,
		Store:  store,
		Cache:  ingest.NewRollingCache(time.Minute),
		Hub:    &fakeHub{},
		AESKey: auth.DeriveAESKey(openCfg.AppEncryptionKey),
	})

	mtr1Req := httptest.NewRequest(http.MethodPost, "/api/tv/targets/"+targetID.String()+"/mtr/run", nil)
	mtr1Rec := httptest.NewRecorder()
	openRouter.ServeHTTP(mtr1Rec, mtr1Req)
	if mtr1Rec.Code != http.StatusAccepted {
		t.Fatalf("first unauth TV MTR trigger got %d, want 202", mtr1Rec.Code)
	}
	mtr2Req := httptest.NewRequest(http.MethodPost, "/api/tv/targets/"+targetID.String()+"/mtr/run", nil)
	mtr2Rec := httptest.NewRecorder()
	openRouter.ServeHTTP(mtr2Rec, mtr2Req)
	if mtr2Rec.Code != http.StatusTooManyRequests || mtr2Rec.Header().Get("Retry-After") == "" {
		t.Fatalf("second immediate unauth TV MTR trigger got %d (Retry-After=%q), want 429", mtr2Rec.Code, mtr2Rec.Header().Get("Retry-After"))
	}

	// Unauthenticated preset write must fail (401), read succeeds (200)
	unauthCreate := httptest.NewRequest(http.MethodPost, "/api/tv/presets", bytes.NewBufferString(`{"name":"Hack","config":{}}`))
	unauthCreateRec := httptest.NewRecorder()
	openRouter.ServeHTTP(unauthCreateRec, unauthCreate)
	if unauthCreateRec.Code != http.StatusUnauthorized {
		t.Fatalf("unauth POST /api/tv/presets got %d, want 401", unauthCreateRec.Code)
	}

	// Login as Admin -> simulate succeeds (200), MTR not throttled, CRUD presets works, /api/tv/matrix sets is_admin=true
	loginReq := httptest.NewRequest(http.MethodPost, "/api/auth/login", bytes.NewBufferString(`{"username":"admin","password":"supersecret123"}`))
	loginRec := httptest.NewRecorder()
	openRouter.ServeHTTP(loginRec, loginReq)
	adminCookie := loginRec.Result().Cookies()[0]

	simAdminReq := httptest.NewRequest(http.MethodPost, "/api/targets/"+targetID.String()+"/simulate", bytes.NewBufferString(`{"mode":"high_latency","duration_sec":30}`))
	simAdminReq.AddCookie(adminCookie)
	simAdminRec := httptest.NewRecorder()
	openRouter.ServeHTTP(simAdminRec, simAdminReq)
	if simAdminRec.Code != http.StatusOK {
		t.Fatalf("admin POST /api/targets/{id}/simulate got %d, want 200", simAdminRec.Code)
	}

	tvAdminReq := httptest.NewRequest(http.MethodGet, "/api/tv/matrix", nil)
	tvAdminReq.AddCookie(adminCookie)
	tvAdminRec := httptest.NewRecorder()
	openRouter.ServeHTTP(tvAdminRec, tvAdminReq)
	var adminMatrix struct {
		IsAdmin bool `json:"is_admin"`
	}
	_ = json.Unmarshal(tvAdminRec.Body.Bytes(), &adminMatrix)
	if !adminMatrix.IsAdmin {
		t.Fatalf("expected is_admin=true for admin cookie on /api/tv/matrix")
	}

	createP1 := httptest.NewRequest(http.MethodPost, "/api/tv/presets", bytes.NewBufferString(`{"name":"NOC Main Wall","config":{"range":"3h","layoutMode":"auto"},"is_default":true}`))
	createP1.AddCookie(adminCookie)
	createP1Rec := httptest.NewRecorder()
	openRouter.ServeHTTP(createP1Rec, createP1)
	if createP1Rec.Code != http.StatusCreated {
		t.Fatalf("admin POST /api/tv/presets got %d (%s), want 201", createP1Rec.Code, createP1Rec.Body.String())
	}
	var preset1 db.TVPreset
	_ = json.Unmarshal(createP1Rec.Body.Bytes(), &preset1)
	if preset1.Slug != "noc-main-wall" || !preset1.IsDefault {
		t.Fatalf("unexpected created preset: %+v", preset1)
	}

	listOpen := httptest.NewRequest(http.MethodGet, "/api/tv/presets", nil)
	listOpenRec := httptest.NewRecorder()
	openRouter.ServeHTTP(listOpenRec, listOpen)
	if listOpenRec.Code != http.StatusOK || !bytes.Contains(listOpenRec.Body.Bytes(), []byte("noc-main-wall")) {
		t.Fatalf("GET /api/tv/presets failed: code=%d body=%s", listOpenRec.Code, listOpenRec.Body.String())
	}

	// 2. Kiosk Token Mode: /api/tv/* requires key/cookie, sets smoker_tv_kiosk cookie, cannot access Admin /api/targets
	kioskCfg := openCfg
	kioskCfg.NocTVKioskToken = "kiosk_secret_token_2026"
	kioskRouter := NewRouter(Dependencies{
		Config: kioskCfg,
		Store:  store,
		Cache:  ingest.NewRollingCache(time.Minute),
		Hub:    &fakeHub{},
		AESKey: auth.DeriveAESKey(kioskCfg.AppEncryptionKey),
	})

	noKeyReq := httptest.NewRequest(http.MethodGet, "/api/tv/matrix", nil)
	noKeyRec := httptest.NewRecorder()
	kioskRouter.ServeHTTP(noKeyRec, noKeyReq)
	if noKeyRec.Code != http.StatusUnauthorized {
		t.Fatalf("GET /api/tv/matrix without kiosk key got %d, want 401", noKeyRec.Code)
	}

	withKeyReq := httptest.NewRequest(http.MethodGet, "/api/tv/matrix?key=kiosk_secret_token_2026", nil)
	withKeyRec := httptest.NewRecorder()
	kioskRouter.ServeHTTP(withKeyRec, withKeyReq)
	if withKeyRec.Code != http.StatusOK {
		t.Fatalf("GET /api/tv/matrix?key=valid got %d, want 200", withKeyRec.Code)
	}
	var kioskCookie *http.Cookie
	for _, c := range withKeyRec.Result().Cookies() {
		if c.Name == auth.TVKioskCookieName {
			kioskCookie = c
		}
	}
	if kioskCookie == nil || !kioskCookie.HttpOnly {
		t.Fatalf("expected HttpOnly smoker_tv_kiosk cookie issued, got %+v", withKeyRec.Result().Cookies())
	}

	// Subsequent request with kiosk cookie only -> 200 on /api/tv/presets, 401 on Admin /api/targets
	cookieTVReq := httptest.NewRequest(http.MethodGet, "/api/tv/presets", nil)
	cookieTVReq.AddCookie(kioskCookie)
	cookieTVRec := httptest.NewRecorder()
	kioskRouter.ServeHTTP(cookieTVRec, cookieTVReq)
	if cookieTVRec.Code != http.StatusOK {
		t.Fatalf("GET /api/tv/presets with kiosk cookie got %d, want 200", cookieTVRec.Code)
	}

	cookieAdminReq := httptest.NewRequest(http.MethodGet, "/api/targets", nil)
	cookieAdminReq.AddCookie(kioskCookie)
	cookieAdminRec := httptest.NewRecorder()
	kioskRouter.ServeHTTP(cookieAdminRec, cookieAdminReq)
	if cookieAdminRec.Code != http.StatusUnauthorized {
		t.Fatalf("kiosk cookie MUST NOT access Admin /api/targets, got %d want 401", cookieAdminRec.Code)
	}
}

func TestSeriesEndpointsSupport3d30dAndCustomDateRange(t *testing.T) {
	t.Parallel()
	pwHash, _ := auth.HashPassword("supersecret123")
	cfg := config.CentralConfig{
		JWTSecret:        "test-jwt-secret-at-least-32-chars!!",
		AppEncryptionKey: "test-aes-secret-at-least-32-chars!!",
		CookieSecure:     "false",
		NocTVAllowUnauth: true,
	}
	tgtID := uuid.New()
	store := &fakeStore{
		adminHash: pwHash,
		probes:    []db.Probe{{ID: uuid.New(), Name: "Local", Status: "online"}},
		targets:   []db.Target{{ID: tgtID, Name: "Core GW", Host: "10.0.0.1", Enabled: true}},
	}
	router := NewRouter(Dependencies{
		Config: cfg,
		Store:  store,
		Cache:  ingest.NewRollingCache(time.Minute),
		Hub:    &fakeHub{},
		AESKey: auth.DeriveAESKey(cfg.AppEncryptionKey),
	})

	// 1. /api/tv/series accepts 3d and 30d presets
	for _, rk := range []string{"3d", "30d"} {
		req := httptest.NewRequest(http.MethodGet, "/api/tv/series?range="+rk+"&ids="+tgtID.String(), nil)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET /api/tv/series?range=%s got %d (%s), want 200", rk, rec.Code, rec.Body.String())
		}
		var out db.BatchSeriesResponse
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		if out.Range != rk {
			t.Fatalf("expected range=%s, got %+v", rk, out)
		}
	}

	// 2. /api/tv/series accepts custom Unix from/to window
	now := time.Now().UTC().Truncate(time.Second)
	fromSec := now.Add(-48 * time.Hour).Unix()
	toSec := now.Add(-24 * time.Hour).Unix()
	customReq := httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/tv/series?from=%d&to=%d&ids=%s", fromSec, toSec, tgtID.String()), nil)
	customRec := httptest.NewRecorder()
	router.ServeHTTP(customRec, customReq)
	if customRec.Code != http.StatusOK {
		t.Fatalf("GET /api/tv/series custom range got %d (%s), want 200", customRec.Code, customRec.Body.String())
	}
	var customOut db.BatchSeriesResponse
	_ = json.Unmarshal(customRec.Body.Bytes(), &customOut)
	if customOut.Range != "custom" || customOut.FromUnix == nil || *customOut.FromUnix != fromSec || customOut.ToUnix == nil || *customOut.ToUnix != toSec {
		t.Fatalf("expected custom range with from=%d to=%d, got %+v", fromSec, toSec, customOut)
	}

	// 3. Invalid custom range (from >= to or missing 'to') -> 400
	for _, badQS := range []string{
		fmt.Sprintf("from=%d&to=%d", toSec, fromSec),
		fmt.Sprintf("from=%d", fromSec),
		"range=99d",
	} {
		badReq := httptest.NewRequest(http.MethodGet, "/api/tv/series?"+badQS, nil)
		badRec := httptest.NewRecorder()
		router.ServeHTTP(badRec, badReq)
		if badRec.Code != http.StatusBadRequest {
			t.Fatalf("GET /api/tv/series?%s got %d, want 400", badQS, badRec.Code)
		}
	}

	// 4. Authenticated /api/targets/{id}/series accepts 3d and RFC3339 custom window
	loginReq := httptest.NewRequest(http.MethodPost, "/api/auth/login", bytes.NewBufferString(`{"username":"admin","password":"supersecret123"}`))
	loginRec := httptest.NewRecorder()
	router.ServeHTTP(loginRec, loginReq)
	sessionCookie := loginRec.Result().Cookies()[0]

	fromRFC := now.Add(-6 * time.Hour).Format(time.RFC3339)
	toRFC := now.Add(-2 * time.Hour).Format(time.RFC3339)
	tgtCustomReq := httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/targets/%s/series?from=%s&to=%s", tgtID.String(), fromRFC, toRFC), nil)
	tgtCustomReq.AddCookie(sessionCookie)
	tgtCustomRec := httptest.NewRecorder()
	router.ServeHTTP(tgtCustomRec, tgtCustomReq)
	if tgtCustomRec.Code != http.StatusOK {
		t.Fatalf("GET /api/targets/{id}/series custom RFC3339 got %d (%s), want 200", tgtCustomRec.Code, tgtCustomRec.Body.String())
	}
	var tgtOut db.TargetSeriesResponse
	_ = json.Unmarshal(tgtCustomRec.Body.Bytes(), &tgtOut)
	if tgtOut.Range != "custom" || tgtOut.FromUnix == nil || tgtOut.ToUnix == nil {
		t.Fatalf("expected custom TargetSeriesResponse with from_unix/to_unix, got %+v", tgtOut)
	}
}
