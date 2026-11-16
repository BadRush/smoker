package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"
	"smoker/internal/central/alerts"
	"smoker/internal/central/auth"
	"smoker/internal/central/config"
	"smoker/internal/central/db"
	"smoker/internal/central/ingest"
	"smoker/internal/protocol"
)

type Store interface {
	Ping(ctx context.Context) error
	GetAdminByUsername(ctx context.Context, username string) (db.AdminUser, error)
	UpdateAdminPassword(ctx context.Context, username, newHash string) error

	ListProbes(ctx context.Context) ([]db.Probe, error)
	CreateProbe(ctx context.Context, name, locationLabel, ispASN, tokenHash string) (db.Probe, error)
	UpdateProbe(ctx context.Context, id uuid.UUID, name, locationLabel, ispASN string) (db.Probe, error)
	RotateProbeToken(ctx context.Context, id uuid.UUID, tokenHash string) (db.Probe, error)
	DeleteProbe(ctx context.Context, id uuid.UUID) error

	ListGroups(ctx context.Context) ([]db.TargetGroup, error)
	CreateGroup(ctx context.Context, name string, parentID *uuid.UUID, desc string, sortOrder int) (db.TargetGroup, error)
	UpdateGroup(ctx context.Context, id uuid.UUID, name string, parentID *uuid.UUID, desc string, sortOrder int) (db.TargetGroup, error)
	DeleteGroup(ctx context.Context, id uuid.UUID) error

	ListTargets(ctx context.Context) ([]db.Target, error)
	GetTarget(ctx context.Context, id uuid.UUID) (db.Target, error)
	CreateTarget(ctx context.Context, in db.TargetInput) (db.Target, error)
	UpdateTarget(ctx context.Context, id uuid.UUID, in db.TargetInput) (db.Target, error)
	DeleteTarget(ctx context.Context, id uuid.UUID) error
	SeedPublicMonitors(ctx context.Context, onlyIfEmpty bool) (db.SeedResult, error)

	QueryTargetSeries(ctx context.Context, targetID uuid.UUID, rangeKey string) (db.TargetSeriesResponse, error)
	QueryBatchTargetSeries(ctx context.Context, targetIDs []uuid.UUID, rangeKey string) (db.BatchSeriesResponse, error)
	ListMTRSnapshots(ctx context.Context, targetID uuid.UUID, limit int) ([]db.MTRSnapshot, error)

	ListAlertRules(ctx context.Context) ([]db.AlertRule, error)
	CreateAlertRule(ctx context.Context, in db.AlertRuleInput) (db.AlertRule, error)
	UpdateAlertRule(ctx context.Context, id uuid.UUID, in db.AlertRuleInput) (db.AlertRule, error)
	DeleteAlertRule(ctx context.Context, id uuid.UUID) error

	ListAlertChannels(ctx context.Context) ([]db.AlertChannel, error)
	GetAlertChannel(ctx context.Context, id uuid.UUID) (db.AlertChannel, error)
	CreateAlertChannel(ctx context.Context, typ, name string, enc []byte, hint string, enabled bool) (db.AlertChannel, error)
	DeleteAlertChannel(ctx context.Context, id uuid.UUID) error

	ListIncidents(ctx context.Context, limit int) ([]db.Incident, error)
	CountOpenIncidents(ctx context.Context) (int, error)

	GetSettings(ctx context.Context) (db.SystemSettings, error)
	UpdateSettingsAndRetention(ctx context.Context, rawDays, aggDays, defaultQuorum int) (db.SystemSettings, error)
}

type HubController interface {
	HandleProbeWS(w http.ResponseWriter, r *http.Request)
	HandleLiveWS(w http.ResponseWriter, r *http.Request)
	SyncAllProbes(ctx context.Context)
	UpdateProbeMeta(probe db.Probe)
	SendRunMTR(ctx context.Context, target db.Target, optionalProbeID *uuid.UUID) ([]string, error)
	BroadcastUI(channel string, event protocol.LiveEvent)
}

type Dependencies struct {
	Config   config.CentralConfig
	Store    Store
	Cache    *ingest.RollingCache
	Hub      HubController
	Notifier *alerts.Notifier
	AESKey   []byte
}

type Server struct {
	cfg      config.CentralConfig
	store    Store
	cache    *ingest.RollingCache
	hub      HubController
	notifier *alerts.Notifier
	aesKey   []byte
	limiter  *auth.LoginRateLimiter
}

func NewRouter(deps Dependencies) http.Handler {
	s := &Server{
		cfg:      deps.Config,
		store:    deps.Store,
		cache:    deps.Cache,
		hub:      deps.Hub,
		notifier: deps.Notifier,
		aesKey:   deps.AESKey,
		limiter:  auth.NewLoginRateLimiter(12, time.Minute),
	}

	r := chi.NewRouter()
	r.Use(requestIDMiddleware)
	r.Use(structuredLogMiddleware)
	r.Use(middleware.Recoverer)

	// Health & Readiness
	r.Get("/healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	r.Get("/readyz", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := s.store.Ping(ctx); err != nil {
			writeProblem(w, r, http.StatusServiceUnavailable, "not_ready", "Database readiness check failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
	})

	// WebSocket Ingress (Probe WS uses token auth, Live WS uses session cookie)
	if s.hub != nil {
		r.Get("/ws/probe", s.hub.HandleProbeWS)
		r.Get("/ws/live", s.hub.HandleLiveWS)
	}

	// Public Auth & Read-Only TV Kiosk Routes
	r.Post("/api/auth/login", s.handleLogin)
	r.Post("/api/auth/logout", s.handleLogout)
	r.Get("/api/tv/matrix", s.handleGetTVMatrix)
	r.Get("/api/tv/series", s.handleGetTVSeries)
	r.Get("/api/tv/targets/{id}/mtr", s.handleListTVTargetMTR)
	r.Post("/api/targets/{id}/simulate", s.handleSimulateTarget)

	// Protected API Routes
	r.Group(func(pr chi.Router) {
		pr.Use(s.requireAuth)

		pr.Get("/api/auth/me", s.handleMe)
		pr.Put("/api/auth/password", s.handleUpdatePassword)

		pr.Get("/api/matrix", s.handleGetMatrix)

		pr.Get("/api/probes", s.handleListProbes)
		pr.Post("/api/probes", s.handleCreateProbe)
		pr.Put("/api/probes/{id}", s.handleUpdateProbe)
		pr.Delete("/api/probes/{id}", s.handleDeleteProbe)
		pr.Post("/api/probes/{id}/rotate-token", s.handleRotateProbeToken)

		pr.Get("/api/groups", s.handleListGroups)
		pr.Post("/api/groups", s.handleCreateGroup)
		pr.Put("/api/groups/{id}", s.handleUpdateGroup)
		pr.Delete("/api/groups/{id}", s.handleDeleteGroup)

		pr.Get("/api/targets", s.handleListTargets)
		pr.Post("/api/targets", s.handleCreateTarget)
		pr.Post("/api/targets/presets", s.handleSeedPresets)
		pr.Get("/api/targets/{id}", s.handleGetTarget)
		pr.Put("/api/targets/{id}", s.handleUpdateTarget)
		pr.Delete("/api/targets/{id}", s.handleDeleteTarget)
		pr.Get("/api/targets/{id}/series", s.handleGetTargetSeries)
		pr.Get("/api/targets/{id}/mtr", s.handleListTargetMTR)
		pr.Post("/api/targets/{id}/mtr/run", s.handleTriggerTargetMTR)

		pr.Get("/api/alerts/rules", s.handleListAlertRules)
		pr.Post("/api/alerts/rules", s.handleCreateAlertRule)
		pr.Put("/api/alerts/rules/{id}", s.handleUpdateAlertRule)
		pr.Delete("/api/alerts/rules/{id}", s.handleDeleteAlertRule)

		pr.Get("/api/alerts/channels", s.handleListAlertChannels)
		pr.Post("/api/alerts/channels", s.handleCreateAlertChannel)
		pr.Delete("/api/alerts/channels/{id}", s.handleDeleteAlertChannel)
		pr.Post("/api/alerts/channels/{id}/test", s.handleTestAlertChannel)

		pr.Get("/api/alerts/incidents", s.handleListIncidents)

		pr.Get("/api/settings", s.handleGetSettings)
		pr.Put("/api/settings", s.handleUpdateSettings)
	})

	return r
}

type ctxKey string

const requestIDKey ctxKey = "req_id"

func requestIDMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reqID := r.Header.Get("X-Request-Id")
		if reqID == "" {
			reqID = uuid.NewString()
		}
		w.Header().Set("X-Request-Id", reqID)
		ctx := context.WithValue(r.Context(), requestIDKey, reqID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func requestIDFromCtx(ctx context.Context) string {
	v, _ := ctx.Value(requestIDKey).(string)
	return v
}

func structuredLogMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" || r.URL.Path == "/readyz" || r.URL.Path == "/ws/probe" || r.URL.Path == "/ws/live" {
			next.ServeHTTP(w, r)
			return
		}
		start := time.Now()
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		next.ServeHTTP(ww, r)
		slog.Info("http request",
			"request_id", requestIDFromCtx(r.Context()),
			"method", r.Method,
			"path", r.URL.Path,
			"status", ww.Status(),
			"duration_ms", time.Since(start).Milliseconds(),
		)
	})
}

func (s *Server) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(auth.SessionCookieName)
		if err != nil || c.Value == "" {
			writeProblem(w, r, http.StatusUnauthorized, "unauthorized", "Authentication required")
			return
		}
		username, err := auth.VerifySessionToken(s.cfg.JWTSecret, c.Value)
		if err != nil {
			writeProblem(w, r, http.StatusUnauthorized, "unauthorized", "Invalid or expired session")
			return
		}
		next.ServeHTTP(w, r.WithContext(auth.WithUsername(r.Context(), username)))
	})
}

func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return err
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeProblem(w http.ResponseWriter, r *http.Request, status int, code, detail string) {
	w.Header().Set("Content-Type", "application/problem+json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"type":       "urn:smoker:error:" + code,
		"title":      http.StatusText(status),
		"status":     status,
		"detail":     detail,
		"request_id": requestIDFromCtx(r.Context()),
	})
}

func parseUUIDParam(w http.ResponseWriter, r *http.Request, param string) (uuid.UUID, bool) {
	id, err := uuid.Parse(chi.URLParam(r, param))
	if err != nil {
		writeProblem(w, r, http.StatusBadRequest, "invalid_uuid", "Invalid UUID parameter: "+param)
		return uuid.Nil, false
	}
	return id, true
}

func handleStoreErr(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, db.ErrNotFound):
		writeProblem(w, r, http.StatusNotFound, "not_found", "Requested resource was not found")
	case errors.Is(err, db.ErrConflict):
		writeProblem(w, r, http.StatusConflict, "conflict", "Resource already exists or conflicts with existing state")
	case errors.Is(err, db.ErrInvalidInput):
		writeProblem(w, r, http.StatusBadRequest, "invalid_input", "Input violates database constraints")
	default:
		slog.Error("internal store error", "request_id", requestIDFromCtx(r.Context()), "err", err)
		writeProblem(w, r, http.StatusInternalServerError, "internal_error", "Unexpected internal error")
	}
}
