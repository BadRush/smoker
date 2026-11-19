package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"smoker/internal/central/alerts"
	"smoker/internal/central/auth"
	"smoker/internal/central/config"
	"smoker/internal/central/db"
	"smoker/internal/central/httpapi"
	"smoker/internal/central/ingest"
	"smoker/internal/central/wshub"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	})))

	cfg, err := config.LoadCentral()
	if err != nil {
		slog.Error("invalid central configuration", "err", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	pool, err := db.NewPool(ctx, cfg.DatabaseURL)
	if err != nil {
		slog.Error("database connection failed", "err", err)
		os.Exit(1)
	}
	defer pool.Close()

	if err := db.RunMigrations(ctx, pool); err != nil {
		slog.Error("database migration failed", "err", err)
		os.Exit(1)
	}

	store := db.NewStore(pool)
	if err := store.EnsureBootstrap(ctx, cfg); err != nil {
		slog.Error("bootstrap failed", "err", err)
		os.Exit(1)
	}

	cache := ingest.NewRollingCache(10 * time.Minute)
	ingestor := ingest.NewIngestor(pool, cache)
	if err := ingestor.WarmCache(ctx); err != nil {
		slog.Warn("warm cache failed", "err", err)
	}

	hub := wshub.NewHub(store, ingestor, cfg.JWTSecret)
	hub.SetNocTVAllowUnauth(cfg.NocTVAllowUnauth)
	hub.SetNocTVKioskToken(cfg.NocTVKioskToken)
	notifier := alerts.NewNotifier()
	aesKey := auth.DeriveAESKey(cfg.AppEncryptionKey)
	evaluator := alerts.NewEvaluator(store, cache, hub, notifier, aesKey, nil)
	evaluator.SetPublicBaseURL(cfg.PublicBaseURL)

	go hub.RunStalenessMonitor(ctx)
	go evaluator.Run(ctx)

	router := httpapi.NewRouter(httpapi.Dependencies{
		Config:   cfg,
		Store:    store,
		Cache:    cache,
		Hub:      hub,
		Notifier: notifier,
		AESKey:   aesKey,
	})

	srv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           router,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}

	go func() {
		slog.Info("smoker central starting", "listen_addr", cfg.ListenAddr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("http server stopped unexpectedly", "err", err)
			stop()
		}
	}()

	<-ctx.Done()
	slog.Info("shutting down smoker central")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		slog.Error("http shutdown failed", "err", err)
	}
}
