package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"smoker/internal/central/alerts"
	"smoker/internal/central/auth"
	"smoker/internal/central/db"
	"smoker/internal/central/ingest"
	"smoker/internal/protocol"
)

// --- Auth ---

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	now := time.Now().UTC()
	if !s.limiter.Allow(r, now) {
		writeProblem(w, r, http.StatusTooManyRequests, "rate_limited", "Too many login attempts; try again in a minute")
		return
	}

	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := decodeJSON(w, r, &req); err != nil {
		writeProblem(w, r, http.StatusBadRequest, "bad_json", "Invalid login payload")
		return
	}
	req.Username = strings.TrimSpace(req.Username)
	if req.Username == "" || req.Password == "" {
		writeProblem(w, r, http.StatusBadRequest, "validation_error", "Username and password are required")
		return
	}

	user, err := s.store.GetAdminByUsername(r.Context(), req.Username)
	if err != nil {
		writeProblem(w, r, http.StatusUnauthorized, "invalid_credentials", "Invalid username or password")
		return
	}
	if err := auth.CheckPassword(user.PasswordHash, req.Password); err != nil {
		writeProblem(w, r, http.StatusUnauthorized, "invalid_credentials", "Invalid username or password")
		return
	}

	ttl := 7 * 24 * time.Hour
	token, err := auth.SignSessionToken(s.cfg.JWTSecret, user.Username, ttl, now)
	if err != nil {
		writeProblem(w, r, http.StatusInternalServerError, "token_error", "Failed to issue session token")
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     auth.SessionCookieName,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   auth.ShouldUseSecureCookie(s.cfg.CookieSecure, r),
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(ttl.Seconds()),
	})
	writeJSON(w, http.StatusOK, map[string]string{"username": user.Username})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     auth.SessionCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   auth.ShouldUseSecureCookie(s.cfg.CookieSecure, r),
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{
		"username": auth.UsernameFromCtx(r.Context()),
	})
}

func (s *Server) handleUpdatePassword(w http.ResponseWriter, r *http.Request) {
	var req struct {
		CurrentPassword string `json:"current_password"`
		NewPassword     string `json:"new_password"`
	}
	if err := decodeJSON(w, r, &req); err != nil {
		writeProblem(w, r, http.StatusBadRequest, "bad_json", "Invalid JSON payload")
		return
	}
	if len(req.NewPassword) < 8 {
		writeProblem(w, r, http.StatusBadRequest, "validation_error", "New password must be at least 8 characters")
		return
	}

	username := auth.UsernameFromCtx(r.Context())
	user, err := s.store.GetAdminByUsername(r.Context(), username)
	if err != nil {
		handleStoreErr(w, r, err)
		return
	}
	if err := auth.CheckPassword(user.PasswordHash, req.CurrentPassword); err != nil {
		writeProblem(w, r, http.StatusUnauthorized, "invalid_password", "Current password is incorrect")
		return
	}
	newHash, err := auth.HashPassword(req.NewPassword)
	if err != nil {
		writeProblem(w, r, http.StatusBadRequest, "validation_error", err.Error())
		return
	}
	if err := s.store.UpdateAdminPassword(r.Context(), username, newHash); err != nil {
		handleStoreErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- Matrix ---

func (s *Server) handleGetMatrix(w http.ResponseWriter, r *http.Request) {
	probes, err := s.store.ListProbes(r.Context())
	if err != nil {
		handleStoreErr(w, r, err)
		return
	}
	groups, err := s.store.ListGroups(r.Context())
	if err != nil {
		handleStoreErr(w, r, err)
		return
	}
	targets, err := s.store.ListTargets(r.Context())
	if err != nil {
		handleStoreErr(w, r, err)
		return
	}
	activeIncidents, err := s.store.CountOpenIncidents(r.Context())
	if err != nil {
		handleStoreErr(w, r, err)
		return
	}

	var cells []ingest.MatrixCell
	if s.cache != nil {
		cells = s.cache.BuildMatrixCells(targets, probes, time.Now().UTC())
	} else {
		cells = []ingest.MatrixCell{}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"probes":           probes,
		"groups":           groups,
		"targets":          targets,
		"cells":            cells,
		"active_incidents": activeIncidents,
		"generated_at":     time.Now().UTC(),
	})
}

func (s *Server) authorizeTVRequest(w http.ResponseWriter, r *http.Request) bool {
	if s.cfg.NocTVAllowUnauth {
		return true
	}
	cookie, err := r.Cookie(auth.SessionCookieName)
	if err != nil {
		writeProblem(w, r, http.StatusUnauthorized, "unauthorized", "Authentication required")
		return false
	}
	if _, err := auth.VerifySessionToken(s.cfg.JWTSecret, cookie.Value); err != nil {
		writeProblem(w, r, http.StatusUnauthorized, "unauthorized", "Invalid or expired session")
		return false
	}
	return true
}

func (s *Server) handleGetTVMatrix(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeTVRequest(w, r) {
		return
	}

	probes, err := s.store.ListProbes(r.Context())
	if err != nil {
		handleStoreErr(w, r, err)
		return
	}
	groups, err := s.store.ListGroups(r.Context())
	if err != nil {
		handleStoreErr(w, r, err)
		return
	}
	allTargets, err := s.store.ListTargets(r.Context())
	if err != nil {
		handleStoreErr(w, r, err)
		return
	}
	targets := make([]db.Target, 0, len(allTargets))
	for _, t := range allTargets {
		if t.Enabled {
			targets = append(targets, t)
		}
	}
	activeIncidents, err := s.store.CountOpenIncidents(r.Context())
	if err != nil {
		handleStoreErr(w, r, err)
		return
	}

	var cells []ingest.MatrixCell
	if s.cache != nil {
		cells = s.cache.BuildMatrixCells(targets, probes, time.Now().UTC())
	} else {
		cells = []ingest.MatrixCell{}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"probes":           probes,
		"groups":           groups,
		"targets":          targets,
		"cells":            cells,
		"active_incidents": activeIncidents,
		"generated_at":     time.Now().UTC(),
	})
}

func (s *Server) handleGetTVSeries(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeTVRequest(w, r) {
		return
	}

	rangeKey := strings.TrimSpace(r.URL.Query().Get("range"))
	if rangeKey == "" {
		rangeKey = "3h"
	}
	switch rangeKey {
	case "15m", "1h", "3h", "6h", "12h", "24h", "7d":
	default:
		writeProblem(w, r, http.StatusBadRequest, "validation_error", "Unsupported TV range; expected one of 15m,1h,3h,6h,12h,24h,7d")
		return
	}

	var targetIDs []uuid.UUID
	if rawIDs := strings.TrimSpace(r.URL.Query().Get("ids")); rawIDs != "" {
		for _, part := range strings.Split(rawIDs, ",") {
			part = strings.TrimSpace(part)
			if part == "" {
				continue
			}
			parsed, err := uuid.Parse(part)
			if err != nil {
				writeProblem(w, r, http.StatusBadRequest, "validation_error", "Invalid target UUID in ids parameter")
				return
			}
			targetIDs = append(targetIDs, parsed)
			if len(targetIDs) >= 24 {
				break
			}
		}
	}

	res, err := s.store.QueryBatchTargetSeries(r.Context(), targetIDs, rangeKey)
	if err != nil {
		handleStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// --- Probes ---

func (s *Server) handleListProbes(w http.ResponseWriter, r *http.Request) {
	probes, err := s.store.ListProbes(r.Context())
	if err != nil {
		handleStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, probes)
}

type probePayload struct {
	Name          string `json:"name"`
	LocationLabel string `json:"location_label"`
	ISPAsn        string `json:"isp_asn"`
}

func parseProbePayload(w http.ResponseWriter, r *http.Request) (probePayload, bool) {
	var req probePayload
	if err := decodeJSON(w, r, &req); err != nil {
		writeProblem(w, r, http.StatusBadRequest, "bad_json", "Invalid JSON payload")
		return req, false
	}
	req.Name = strings.TrimSpace(req.Name)
	req.LocationLabel = strings.TrimSpace(req.LocationLabel)
	req.ISPAsn = strings.TrimSpace(req.ISPAsn)
	if len(req.Name) < 2 || len(req.Name) > 80 {
		writeProblem(w, r, http.StatusBadRequest, "validation_error", "Probe name must be 2..80 characters")
		return req, false
	}
	if len(req.LocationLabel) > 120 {
		writeProblem(w, r, http.StatusBadRequest, "validation_error", "Location label must be <= 120 characters")
		return req, false
	}
	if len(req.ISPAsn) > 120 {
		writeProblem(w, r, http.StatusBadRequest, "validation_error", "ISP / ASN must be <= 120 characters")
		return req, false
	}
	return req, true
}

func (s *Server) handleCreateProbe(w http.ResponseWriter, r *http.Request) {
	req, ok := parseProbePayload(w, r)
	if !ok {
		return
	}

	plaintext, hash, err := auth.GenerateProbeToken()
	if err != nil {
		writeProblem(w, r, http.StatusInternalServerError, "token_gen_error", "Failed to generate probe token")
		return
	}
	probe, err := s.store.CreateProbe(r.Context(), req.Name, req.LocationLabel, req.ISPAsn, hash)
	if err != nil {
		handleStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"probe": probe,
		"token": plaintext,
	})
}

func (s *Server) handleUpdateProbe(w http.ResponseWriter, r *http.Request) {
	id, ok := parseUUIDParam(w, r, "id")
	if !ok {
		return
	}
	req, ok := parseProbePayload(w, r)
	if !ok {
		return
	}
	probe, err := s.store.UpdateProbe(r.Context(), id, req.Name, req.LocationLabel, req.ISPAsn)
	if err != nil {
		handleStoreErr(w, r, err)
		return
	}
	if s.hub != nil {
		s.hub.UpdateProbeMeta(probe)
	}
	writeJSON(w, http.StatusOK, probe)
}

func (s *Server) handleDeleteProbe(w http.ResponseWriter, r *http.Request) {
	id, ok := parseUUIDParam(w, r, "id")
	if !ok {
		return
	}
	if err := s.store.DeleteProbe(r.Context(), id); err != nil {
		var inUse *db.ProbeInUseError
		if errors.As(err, &inUse) {
			writeProblem(w, r, http.StatusConflict, "probe_in_use",
				"Cannot delete probe because it is the sole assigned probe for active target(s): "+strings.Join(inUse.TargetNames, ", "))
			return
		}
		handleStoreErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleRotateProbeToken(w http.ResponseWriter, r *http.Request) {
	id, ok := parseUUIDParam(w, r, "id")
	if !ok {
		return
	}
	plaintext, hash, err := auth.GenerateProbeToken()
	if err != nil {
		writeProblem(w, r, http.StatusInternalServerError, "token_gen_error", "Failed to rotate probe token")
		return
	}
	probe, err := s.store.RotateProbeToken(r.Context(), id, hash)
	if err != nil {
		handleStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"probe": probe,
		"token": plaintext,
	})
}

// --- Target Groups ---

func (s *Server) handleListGroups(w http.ResponseWriter, r *http.Request) {
	groups, err := s.store.ListGroups(r.Context())
	if err != nil {
		handleStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, groups)
}

func (s *Server) handleCreateGroup(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name        string     `json:"name"`
		ParentID    *uuid.UUID `json:"parent_id"`
		Description string     `json:"description"`
		SortOrder   int        `json:"sort_order"`
	}
	if err := decodeJSON(w, r, &req); err != nil {
		writeProblem(w, r, http.StatusBadRequest, "bad_json", "Invalid group payload")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || len(req.Name) > 80 {
		writeProblem(w, r, http.StatusBadRequest, "validation_error", "Group name must be 1..80 characters")
		return
	}
	g, err := s.store.CreateGroup(r.Context(), req.Name, req.ParentID, strings.TrimSpace(req.Description), req.SortOrder)
	if err != nil {
		handleStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, g)
}

func (s *Server) handleUpdateGroup(w http.ResponseWriter, r *http.Request) {
	id, ok := parseUUIDParam(w, r, "id")
	if !ok {
		return
	}
	var req struct {
		Name        string     `json:"name"`
		ParentID    *uuid.UUID `json:"parent_id"`
		Description string     `json:"description"`
		SortOrder   int        `json:"sort_order"`
	}
	if err := decodeJSON(w, r, &req); err != nil {
		writeProblem(w, r, http.StatusBadRequest, "bad_json", "Invalid group payload")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || len(req.Name) > 80 {
		writeProblem(w, r, http.StatusBadRequest, "validation_error", "Group name must be 1..80 characters")
		return
	}
	if req.ParentID != nil && *req.ParentID == id {
		writeProblem(w, r, http.StatusBadRequest, "validation_error", "Group cannot be its own parent")
		return
	}
	g, err := s.store.UpdateGroup(r.Context(), id, req.Name, req.ParentID, strings.TrimSpace(req.Description), req.SortOrder)
	if err != nil {
		handleStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, g)
}

func (s *Server) handleDeleteGroup(w http.ResponseWriter, r *http.Request) {
	id, ok := parseUUIDParam(w, r, "id")
	if !ok {
		return
	}
	if err := s.store.DeleteGroup(r.Context(), id); err != nil {
		handleStoreErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- Targets ---

type targetRequest struct {
	GroupID               *uuid.UUID     `json:"group_id"`
	Name                  string         `json:"name"`
	Host                  string         `json:"host"`
	ProbeType             string         `json:"probe_type"`
	PortOrPath            string         `json:"port_or_path"`
	IntervalSec           *int           `json:"interval_sec"`
	TimeoutMs             *int           `json:"timeout_ms"`
	Enabled               *bool          `json:"enabled"`
	AutoMTROnLoss         *bool          `json:"auto_mtr_on_loss"`
	MTRLossThreshold      *int           `json:"mtr_loss_threshold"`
	PinnedOnTV            *bool          `json:"pinned_on_tv"`
	LatencyWarnMs         *int           `json:"latency_warn_ms"`
	ProbeLatencyOverrides map[string]int `json:"probe_latency_overrides"`
	AssignAllProbes       *bool          `json:"assign_all_probes"`
	ProbeIDs              []uuid.UUID    `json:"probe_ids"`
}

func validateTargetInput(req targetRequest) (db.TargetInput, string) {
	name := strings.TrimSpace(req.Name)
	host := strings.TrimSpace(req.Host)
	pt := strings.ToLower(strings.TrimSpace(req.ProbeType))
	if len(name) < 1 || len(name) > 100 {
		return db.TargetInput{}, "Target name must be 1..100 characters"
	}
	if len(host) < 1 || len(host) > 255 || strings.ContainsAny(host, " \t\n\r") {
		return db.TargetInput{}, "Target host must be a valid IP, hostname, or URL without spaces"
	}
	switch pt {
	case "icmp", "icmp6", "tcp", "tcp6", "http", "http6", "dns", "dns6":
	default:
		return db.TargetInput{}, "probe_type must be one of: icmp, icmp6, tcp, tcp6, http, http6, dns, dns6"
	}
	if strings.HasSuffix(pt, "6") {
		candidateHost := host
		if strings.Contains(candidateHost, "://") {
			if u, err := url.Parse(candidateHost); err == nil {
				candidateHost = u.Hostname()
			}
		} else if h, _, err := net.SplitHostPort(candidateHost); err == nil && strings.HasPrefix(candidateHost, "[") {
			candidateHost = h
		}
		candidateHost = strings.TrimSuffix(strings.TrimPrefix(strings.TrimSpace(candidateHost), "["), "]")
		if ip := net.ParseIP(candidateHost); ip != nil && ip.To4() != nil {
			return db.TargetInput{}, "IPv6 probe_type requires an IPv6 address or hostname, got IPv4 literal"
		}
	}
	if pt == "tcp" || pt == "tcp6" {
		port, err := strconv.Atoi(strings.TrimSpace(req.PortOrPath))
		if err != nil || port < 1 || port > 65535 {
			return db.TargetInput{}, "TCP probe requires port_or_path between 1 and 65535"
		}
	}

	interval := 1
	if req.IntervalSec != nil {
		interval = *req.IntervalSec
	}
	if interval < 1 || interval > 300 {
		return db.TargetInput{}, "interval_sec must be between 1 and 300"
	}

	timeout := 1000
	if req.TimeoutMs != nil {
		timeout = *req.TimeoutMs
	}
	if timeout < 100 || timeout > 10000 {
		return db.TargetInput{}, "timeout_ms must be between 100 and 10000"
	}

	enabled := true
	if req.Enabled != nil {
		enabled = *req.Enabled
	}
	autoMTR := true
	if req.AutoMTROnLoss != nil {
		autoMTR = *req.AutoMTROnLoss
	}
	mtrThresh := 3
	if req.MTRLossThreshold != nil {
		mtrThresh = *req.MTRLossThreshold
	}
	if mtrThresh < 1 || mtrThresh > 60 {
		return db.TargetInput{}, "mtr_loss_threshold must be between 1 and 60"
	}
	pinnedOnTV := false
	if req.PinnedOnTV != nil {
		pinnedOnTV = *req.PinnedOnTV
	}
	latencyWarnMs := 0
	if req.LatencyWarnMs != nil {
		latencyWarnMs = *req.LatencyWarnMs
	}
	if latencyWarnMs < 0 || latencyWarnMs > 10000 {
		return db.TargetInput{}, "latency_warn_ms must be between 0 and 10000"
	}
	assignAll := true
	if req.AssignAllProbes != nil {
		assignAll = *req.AssignAllProbes
	}
	cleanProbeIDs := make([]uuid.UUID, 0, len(req.ProbeIDs))
	assignedSet := make(map[string]bool)
	if !assignAll {
		seen := make(map[uuid.UUID]bool, len(req.ProbeIDs))
		for _, pid := range req.ProbeIDs {
			if pid == uuid.Nil || seen[pid] {
				continue
			}
			seen[pid] = true
			cleanProbeIDs = append(cleanProbeIDs, pid)
			assignedSet[pid.String()] = true
		}
		if len(cleanProbeIDs) == 0 {
			return db.TargetInput{}, "At least one probe must be selected when assign_all_probes is false"
		}
	}
	cleanOverrides := make(map[string]int)
	for k, v := range req.ProbeLatencyOverrides {
		if _, err := uuid.Parse(k); err == nil && v > 0 && v <= 10000 {
			if assignAll || assignedSet[k] {
				cleanOverrides[k] = v
			}
		}
	}

	return db.TargetInput{
		GroupID:               req.GroupID,
		Name:                  name,
		Host:                  host,
		ProbeType:             pt,
		PortOrPath:            strings.TrimSpace(req.PortOrPath),
		IntervalSec:           interval,
		TimeoutMs:             timeout,
		Enabled:               enabled,
		AutoMTROnLoss:         autoMTR,
		MTRLossThreshold:      mtrThresh,
		PinnedOnTV:            pinnedOnTV,
		LatencyWarnMs:         latencyWarnMs,
		ProbeLatencyOverrides: cleanOverrides,
		AssignAllProbes:       assignAll,
		ProbeIDs:              cleanProbeIDs,
	}, ""
}

func (s *Server) handleListTargets(w http.ResponseWriter, r *http.Request) {
	targets, err := s.store.ListTargets(r.Context())
	if err != nil {
		handleStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, targets)
}

func (s *Server) handleGetTarget(w http.ResponseWriter, r *http.Request) {
	id, ok := parseUUIDParam(w, r, "id")
	if !ok {
		return
	}
	t, err := s.store.GetTarget(r.Context(), id)
	if err != nil {
		handleStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, t)
}

func (s *Server) handleCreateTarget(w http.ResponseWriter, r *http.Request) {
	var req targetRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeProblem(w, r, http.StatusBadRequest, "bad_json", "Invalid target payload")
		return
	}
	in, errMsg := validateTargetInput(req)
	if errMsg != "" {
		writeProblem(w, r, http.StatusBadRequest, "validation_error", errMsg)
		return
	}
	t, err := s.store.CreateTarget(r.Context(), in)
	if err != nil {
		handleStoreErr(w, r, err)
		return
	}
	s.syncProbesAsync()
	writeJSON(w, http.StatusCreated, t)
}

func (s *Server) handleUpdateTarget(w http.ResponseWriter, r *http.Request) {
	id, ok := parseUUIDParam(w, r, "id")
	if !ok {
		return
	}
	var req targetRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeProblem(w, r, http.StatusBadRequest, "bad_json", "Invalid target payload")
		return
	}
	in, errMsg := validateTargetInput(req)
	if errMsg != "" {
		writeProblem(w, r, http.StatusBadRequest, "validation_error", errMsg)
		return
	}
	t, err := s.store.UpdateTarget(r.Context(), id, in)
	if err != nil {
		handleStoreErr(w, r, err)
		return
	}
	s.syncProbesAsync()
	writeJSON(w, http.StatusOK, t)
}

func (s *Server) handleDeleteTarget(w http.ResponseWriter, r *http.Request) {
	id, ok := parseUUIDParam(w, r, "id")
	if !ok {
		return
	}
	if err := s.store.DeleteTarget(r.Context(), id); err != nil {
		handleStoreErr(w, r, err)
		return
	}
	s.syncProbesAsync()
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) syncProbesAsync() {
	if s.hub == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		s.hub.SyncAllProbes(ctx)
	}()
}

func (s *Server) handleSeedPresets(w http.ResponseWriter, r *http.Request) {
	res, err := s.store.SeedPublicMonitors(r.Context(), false)
	if err != nil {
		handleStoreErr(w, r, err)
		return
	}
	if res.TargetsCreated > 0 {
		s.syncProbesAsync()
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handleGetTargetSeries(w http.ResponseWriter, r *http.Request) {
	id, ok := parseUUIDParam(w, r, "id")
	if !ok {
		return
	}
	rangeKey := r.URL.Query().Get("range")
	if rangeKey == "" {
		rangeKey = "5m"
	}
	res, err := s.store.QueryTargetSeries(r.Context(), id, rangeKey)
	if err != nil {
		handleStoreErr(w, r, err)
		return
	}
	if s.cache != nil && len(res.Series) > 0 {
		probes := make([]db.Probe, 0, len(res.Series))
		for _, ps := range res.Series {
			probes = append(probes, db.Probe{ID: ps.ProbeID})
		}
		cells := s.cache.BuildMatrixCells([]db.Target{res.Target}, probes, time.Now().UTC())
		byProbe := make(map[uuid.UUID]ingest.MatrixCell, len(cells))
		for _, c := range cells {
			byProbe[c.ProbeID] = c
		}
		for i := range res.Series {
			if c, ok := byProbe[res.Series[i].ProbeID]; ok {
				res.Series[i].BaselineMs = c.BaselineMs
				res.Series[i].WarnMs = c.WarnMs
			}
		}
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handleListTargetMTR(w http.ResponseWriter, r *http.Request) {
	id, ok := parseUUIDParam(w, r, "id")
	if !ok {
		return
	}
	limit := 25
	if q := r.URL.Query().Get("limit"); q != "" {
		if parsed, err := strconv.Atoi(q); err == nil && parsed > 0 && parsed <= 100 {
			limit = parsed
		}
	}
	snaps, err := s.store.ListMTRSnapshots(r.Context(), id, limit)
	if err != nil {
		handleStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, snaps)
}

func (s *Server) handleListTVTargetMTR(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeTVRequest(w, r) {
		return
	}
	s.handleListTargetMTR(w, r)
}

func (s *Server) handleTriggerTargetMTR(w http.ResponseWriter, r *http.Request) {
	id, ok := parseUUIDParam(w, r, "id")
	if !ok {
		return
	}
	target, err := s.store.GetTarget(r.Context(), id)
	if err != nil {
		handleStoreErr(w, r, err)
		return
	}
	var body struct {
		ProbeID *uuid.UUID `json:"probe_id"`
	}
	if r.ContentLength > 0 {
		if err := decodeJSON(w, r, &body); err != nil {
			writeProblem(w, r, http.StatusBadRequest, "bad_json", "Invalid MTR trigger payload")
			return
		}
	}
	if s.hub == nil {
		writeJSON(w, http.StatusAccepted, map[string]any{"request_ids": []string{}})
		return
	}
	reqIDs, err := s.hub.SendRunMTR(r.Context(), target, body.ProbeID)
	if err != nil {
		writeProblem(w, r, http.StatusInternalServerError, "mtr_dispatch_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"request_ids": reqIDs})
}

func (s *Server) handleSimulateTarget(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeTVRequest(w, r) {
		return
	}

	id, ok := parseUUIDParam(w, r, "id")
	if !ok {
		return
	}
	target, err := s.store.GetTarget(r.Context(), id)
	if err != nil {
		handleStoreErr(w, r, err)
		return
	}

	var req struct {
		Mode        string     `json:"mode"`
		DurationSec int        `json:"duration_sec"`
		ProbeID     *uuid.UUID `json:"probe_id"`
	}
	if r.ContentLength > 0 {
		if err := decodeJSON(w, r, &req); err != nil {
			writeProblem(w, r, http.StatusBadRequest, "bad_json", "Invalid simulate payload")
			return
		}
	}
	mode := strings.ToLower(strings.TrimSpace(req.Mode))
	if mode == "" {
		mode = "high_latency"
	}
	switch mode {
	case "high_latency", "intermittent_loss", "down", "clear":
	default:
		writeProblem(w, r, http.StatusBadRequest, "validation_error", "mode must be high_latency, intermittent_loss, down, or clear")
		return
	}
	durSec := req.DurationSec
	if durSec <= 0 {
		durSec = 30
	}
	if durSec > 120 {
		durSec = 120
	}

	probes, err := s.store.ListProbes(r.Context())
	if err != nil {
		handleStoreErr(w, r, err)
		return
	}

	var probeIDs []uuid.UUID
	if req.ProbeID != nil {
		probeIDs = []uuid.UUID{*req.ProbeID}
	} else if !target.AssignAllProbes && len(target.ProbeIDs) > 0 {
		probeIDs = target.ProbeIDs
	} else {
		for _, p := range probes {
			probeIDs = append(probeIDs, p.ID)
		}
	}

	now := time.Now().UTC()
	if s.cache != nil {
		s.cache.SimulateAnomaly(target.ID, probeIDs, mode, time.Duration(durSec)*time.Second, now)
	}
	if s.hub != nil {
		s.hub.BroadcastUI("matrix", protocol.LiveEvent{
			Type:    "incident_update",
			Channel: "matrix",
			Data: map[string]any{
				"target_id":    target.ID.String(),
				"mode":         mode,
				"duration_sec": durSec,
			},
		})
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"target_id":    target.ID,
		"mode":         mode,
		"duration_sec": durSec,
		"until":        now.Add(time.Duration(durSec) * time.Second),
	})
}

// --- Alerts ---

type alertRuleReq struct {
	Name            string      `json:"name"`
	TargetID        *uuid.UUID  `json:"target_id"`
	GroupID         *uuid.UUID  `json:"group_id"`
	Metric          string      `json:"metric"`
	ThresholdValue  float64     `json:"threshold_value"`
	DurationSec     int         `json:"duration_sec"`
	QuorumMinProbes int         `json:"quorum_min_probes"`
	CooldownSec     int         `json:"cooldown_sec"`
	ConfirmSec      *int        `json:"confirm_sec"`
	RecoverSec      *int        `json:"recover_sec"`
	ChannelIDs      []uuid.UUID `json:"channel_ids"`
	Enabled         *bool       `json:"enabled"`
}

func validateAlertRuleReq(req alertRuleReq) (db.AlertRuleInput, string) {
	name := strings.TrimSpace(req.Name)
	if name == "" || len(name) > 100 {
		return db.AlertRuleInput{}, "Rule name must be 1..100 characters"
	}
	switch req.Metric {
	case "latency_p95", "loss_pct", "jitter", "probe_offline", "baseline_spike_pct":
	default:
		return db.AlertRuleInput{}, "metric must be latency_p95, loss_pct, jitter, probe_offline, or baseline_spike_pct"
	}
	targetID := req.TargetID
	groupID := req.GroupID
	if req.Metric == "probe_offline" {
		targetID = nil
		groupID = nil
	} else if targetID != nil && groupID != nil {
		return db.AlertRuleInput{}, "target_id and group_id cannot both be specified"
	}
	if req.ThresholdValue < 0 {
		return db.AlertRuleInput{}, "threshold_value must be >= 0"
	}
	if req.DurationSec < 5 || req.DurationSec > 3600 {
		return db.AlertRuleInput{}, "duration_sec must be between 5 and 3600"
	}
	if req.QuorumMinProbes < 1 {
		return db.AlertRuleInput{}, "quorum_min_probes must be >= 1"
	}
	if req.CooldownSec != 0 && (req.CooldownSec < 10 || req.CooldownSec > 86400) {
		return db.AlertRuleInput{}, "cooldown_sec must be 0 (off) or between 10 and 86400"
	}
	confirmSec := 0
	if req.ConfirmSec != nil {
		confirmSec = *req.ConfirmSec
	}
	if confirmSec < 0 || confirmSec > 3600 {
		return db.AlertRuleInput{}, "confirm_sec must be between 0 and 3600"
	}
	recoverSec := 45
	if req.RecoverSec != nil {
		recoverSec = *req.RecoverSec
	}
	if recoverSec < 0 || recoverSec > 3600 {
		return db.AlertRuleInput{}, "recover_sec must be between 0 and 3600"
	}
	enabled := true
	if req.Enabled != nil {
		enabled = *req.Enabled
	}
	return db.AlertRuleInput{
		Name:            name,
		TargetID:        targetID,
		GroupID:         groupID,
		Metric:          req.Metric,
		ThresholdValue:  req.ThresholdValue,
		DurationSec:     req.DurationSec,
		QuorumMinProbes: req.QuorumMinProbes,
		CooldownSec:     req.CooldownSec,
		ConfirmSec:      confirmSec,
		RecoverSec:      recoverSec,
		ChannelIDs:      req.ChannelIDs,
		Enabled:         enabled,
	}, ""
}

func (s *Server) handleListAlertRules(w http.ResponseWriter, r *http.Request) {
	rules, err := s.store.ListAlertRules(r.Context())
	if err != nil {
		handleStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, rules)
}

func (s *Server) handleCreateAlertRule(w http.ResponseWriter, r *http.Request) {
	var req alertRuleReq
	if err := decodeJSON(w, r, &req); err != nil {
		writeProblem(w, r, http.StatusBadRequest, "bad_json", "Invalid rule payload")
		return
	}
	in, errMsg := validateAlertRuleReq(req)
	if errMsg != "" {
		writeProblem(w, r, http.StatusBadRequest, "validation_error", errMsg)
		return
	}
	rule, err := s.store.CreateAlertRule(r.Context(), in)
	if err != nil {
		handleStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, rule)
}

func (s *Server) handleUpdateAlertRule(w http.ResponseWriter, r *http.Request) {
	id, ok := parseUUIDParam(w, r, "id")
	if !ok {
		return
	}
	var req alertRuleReq
	if err := decodeJSON(w, r, &req); err != nil {
		writeProblem(w, r, http.StatusBadRequest, "bad_json", "Invalid rule payload")
		return
	}
	in, errMsg := validateAlertRuleReq(req)
	if errMsg != "" {
		writeProblem(w, r, http.StatusBadRequest, "validation_error", errMsg)
		return
	}
	rule, err := s.store.UpdateAlertRule(r.Context(), id, in)
	if err != nil {
		handleStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, rule)
}

func (s *Server) handleDeleteAlertRule(w http.ResponseWriter, r *http.Request) {
	id, ok := parseUUIDParam(w, r, "id")
	if !ok {
		return
	}
	if err := s.store.DeleteAlertRule(r.Context(), id); err != nil {
		handleStoreErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleListAlertChannels(w http.ResponseWriter, r *http.Request) {
	channels, err := s.store.ListAlertChannels(r.Context())
	if err != nil {
		handleStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, channels)
}

func parseOptionalThreadID(raw json.RawMessage) (int64, error) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return 0, nil
	}
	var asNum int64
	if err := json.Unmarshal(raw, &asNum); err == nil {
		if asNum <= 0 {
			return 0, errors.New("thread_id must be a positive integer")
		}
		return asNum, nil
	}
	var asStr string
	if err := json.Unmarshal(raw, &asStr); err == nil {
		asStr = strings.TrimSpace(asStr)
		if asStr == "" {
			return 0, nil
		}
		n, err := strconv.ParseInt(asStr, 10, 64)
		if err != nil || n <= 0 {
			return 0, errors.New("thread_id must be a positive integer")
		}
		return n, nil
	}
	return 0, errors.New("thread_id must be a positive integer")
}

type alertChannelReq struct {
	Type       string          `json:"type"`
	Name       string          `json:"name"`
	BotToken   string          `json:"bot_token"`
	ChatID     string          `json:"chat_id"`
	ThreadID   json.RawMessage `json:"thread_id"`
	WebhookURL string          `json:"webhook_url"`
	Enabled    *bool           `json:"enabled"`
}

func buildAlertChannelSecret(chType string, req alertChannelReq, existing *alerts.ChannelSecret) (alerts.ChannelSecret, string, string) {
	var sec alerts.ChannelSecret
	if existing != nil {
		sec = *existing
	}
	switch chType {
	case "telegram":
		botToken := strings.TrimSpace(req.BotToken)
		if botToken != "" {
			sec.BotToken = botToken
		}
		chatID := strings.TrimSpace(req.ChatID)
		if chatID != "" {
			sec.ChatID = chatID
		}
		if sec.BotToken == "" || sec.ChatID == "" {
			return alerts.ChannelSecret{}, "", "bot_token and chat_id are required for Telegram"
		}
		if len(req.ThreadID) > 0 {
			threadID, err := parseOptionalThreadID(req.ThreadID)
			if err != nil {
				return alerts.ChannelSecret{}, "", err.Error()
			}
			sec.ThreadID = threadID
		}
		hint := "chat:" + sec.ChatID
		if sec.ThreadID > 0 {
			hint += " · thread:" + strconv.FormatInt(sec.ThreadID, 10)
		}
		return sec, hint, ""
	case "webhook":
		webhookURL := strings.TrimSpace(req.WebhookURL)
		if webhookURL != "" {
			sec.WebhookURL = webhookURL
		}
		u, err := url.Parse(sec.WebhookURL)
		if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
			return alerts.ChannelSecret{}, "", "Valid http(s) webhook_url is required"
		}
		tail := u.Path
		if len(tail) > 6 {
			tail = "..." + tail[len(tail)-6:]
		}
		return sec, u.Scheme + "://" + u.Host + tail, ""
	default:
		return alerts.ChannelSecret{}, "", "type must be telegram or webhook"
	}
}

func (s *Server) handleCreateAlertChannel(w http.ResponseWriter, r *http.Request) {
	var req alertChannelReq
	if err := decodeJSON(w, r, &req); err != nil {
		writeProblem(w, r, http.StatusBadRequest, "bad_json", "Invalid channel payload")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	req.Type = strings.ToLower(strings.TrimSpace(req.Type))
	if req.Name == "" || len(req.Name) > 80 {
		writeProblem(w, r, http.StatusBadRequest, "validation_error", "Channel name must be 1..80 characters")
		return
	}

	sec, hint, errMsg := buildAlertChannelSecret(req.Type, req, nil)
	if errMsg != "" {
		writeProblem(w, r, http.StatusBadRequest, "validation_error", errMsg)
		return
	}

	plain, err := json.Marshal(sec)
	if err != nil {
		writeProblem(w, r, http.StatusInternalServerError, "encode_error", "Failed to encode channel secret")
		return
	}
	enc, err := auth.EncryptAESGCM(s.aesKey, plain)
	if err != nil {
		writeProblem(w, r, http.StatusInternalServerError, "encrypt_error", "Failed to encrypt channel secret")
		return
	}
	enabled := true
	if req.Enabled != nil {
		enabled = *req.Enabled
	}

	ch, err := s.store.CreateAlertChannel(r.Context(), req.Type, req.Name, enc, hint, enabled)
	if err != nil {
		handleStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, ch)
}

func (s *Server) handleUpdateAlertChannel(w http.ResponseWriter, r *http.Request) {
	id, ok := parseUUIDParam(w, r, "id")
	if !ok {
		return
	}
	existingCh, err := s.store.GetAlertChannel(r.Context(), id)
	if err != nil {
		handleStoreErr(w, r, err)
		return
	}
	plainOld, err := auth.DecryptAESGCM(s.aesKey, existingCh.ConfigEncrypted)
	if err != nil {
		writeProblem(w, r, http.StatusInternalServerError, "decrypt_error", "Failed to decrypt existing channel credentials")
		return
	}
	var oldSec alerts.ChannelSecret
	if err := json.Unmarshal(plainOld, &oldSec); err != nil {
		writeProblem(w, r, http.StatusInternalServerError, "decode_error", "Corrupt channel configuration")
		return
	}

	var req alertChannelReq
	if err := decodeJSON(w, r, &req); err != nil {
		writeProblem(w, r, http.StatusBadRequest, "bad_json", "Invalid channel payload")
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = existingCh.Name
	}
	if len(name) > 80 {
		writeProblem(w, r, http.StatusBadRequest, "validation_error", "Channel name must be 1..80 characters")
		return
	}
	sec, hint, errMsg := buildAlertChannelSecret(existingCh.Type, req, &oldSec)
	if errMsg != "" {
		writeProblem(w, r, http.StatusBadRequest, "validation_error", errMsg)
		return
	}
	plainNew, err := json.Marshal(sec)
	if err != nil {
		writeProblem(w, r, http.StatusInternalServerError, "encode_error", "Failed to encode channel secret")
		return
	}
	encNew, err := auth.EncryptAESGCM(s.aesKey, plainNew)
	if err != nil {
		writeProblem(w, r, http.StatusInternalServerError, "encrypt_error", "Failed to encrypt channel secret")
		return
	}
	enabled := existingCh.Enabled
	if req.Enabled != nil {
		enabled = *req.Enabled
	}

	updated, err := s.store.UpdateAlertChannel(r.Context(), id, name, encNew, hint, enabled)
	if err != nil {
		handleStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

func (s *Server) handleDeleteAlertChannel(w http.ResponseWriter, r *http.Request) {
	id, ok := parseUUIDParam(w, r, "id")
	if !ok {
		return
	}
	if err := s.store.DeleteAlertChannel(r.Context(), id); err != nil {
		handleStoreErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleTestAlertChannel(w http.ResponseWriter, r *http.Request) {
	id, ok := parseUUIDParam(w, r, "id")
	if !ok {
		return
	}
	ch, err := s.store.GetAlertChannel(r.Context(), id)
	if err != nil {
		handleStoreErr(w, r, err)
		return
	}
	plain, err := auth.DecryptAESGCM(s.aesKey, ch.ConfigEncrypted)
	if err != nil {
		writeProblem(w, r, http.StatusInternalServerError, "decrypt_error", "Failed to decrypt channel credentials")
		return
	}
	var sec alerts.ChannelSecret
	if err := json.Unmarshal(plain, &sec); err != nil {
		writeProblem(w, r, http.StatusInternalServerError, "decode_error", "Corrupt channel configuration")
		return
	}

	msg := alerts.AlertMessage{
		Status:         "TEST",
		Severity:       "test",
		RuleName:       "Channel Verification",
		TargetName:     ch.Name,
		Metric:         "latency_p95",
		QuorumCount:    1,
		QuorumRequired: 1,
		AffectedProbes: []string{"Local Central Probe"},
		Summary:        "Notification connection verified",
		Timestamp:      time.Now().UTC().Format(time.RFC3339),
	}

	var sendErr error
	switch ch.Type {
	case "telegram":
		sendErr = s.notifier.SendTelegram(r.Context(), sec.BotToken, sec.ChatID, sec.ThreadID, msg)
	case "webhook":
		sendErr = s.notifier.SendWebhook(r.Context(), sec.WebhookURL, msg)
	}
	if sendErr != nil {
		writeProblem(w, r, http.StatusBadGateway, "delivery_failed", sendErr.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": "Test notification delivered"})
}

func (s *Server) handleListIncidents(w http.ResponseWriter, r *http.Request) {
	limit := 50
	if q := r.URL.Query().Get("limit"); q != "" {
		if parsed, err := strconv.Atoi(q); err == nil && parsed > 0 && parsed <= 100 {
			limit = parsed
		}
	}
	items, err := s.store.ListIncidents(r.Context(), limit)
	if err != nil {
		handleStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, items)
}

// --- Settings ---

func (s *Server) handleGetSettings(w http.ResponseWriter, r *http.Request) {
	st, err := s.store.GetSettings(r.Context())
	if err != nil {
		handleStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) handleUpdateSettings(w http.ResponseWriter, r *http.Request) {
	var req struct {
		RawRetentionDays int `json:"raw_retention_days"`
		AggRetentionDays int `json:"agg_retention_days"`
		DefaultQuorumMin int `json:"default_quorum_min"`
	}
	if err := decodeJSON(w, r, &req); err != nil {
		writeProblem(w, r, http.StatusBadRequest, "bad_json", "Invalid settings payload")
		return
	}
	if req.RawRetentionDays < 1 || req.RawRetentionDays > 90 {
		writeProblem(w, r, http.StatusBadRequest, "validation_error", "raw_retention_days must be between 1 and 90")
		return
	}
	if req.AggRetentionDays < 30 || req.AggRetentionDays > 3650 {
		writeProblem(w, r, http.StatusBadRequest, "validation_error", "agg_retention_days must be between 30 and 3650")
		return
	}
	if req.DefaultQuorumMin < 1 {
		writeProblem(w, r, http.StatusBadRequest, "validation_error", "default_quorum_min must be >= 1")
		return
	}

	st, err := s.store.UpdateSettingsAndRetention(r.Context(), req.RawRetentionDays, req.AggRetentionDays, req.DefaultQuorumMin)
	if err != nil {
		handleStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, st)
}
