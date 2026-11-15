package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"smoker/internal/probe/buffer"
	"smoker/internal/probe/clock"
	"smoker/internal/probe/config"
	"smoker/internal/probe/engine"
	"smoker/internal/probe/uplink"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	})))

	cfg, err := config.LoadProbe()
	if err != nil {
		slog.Error("invalid probe configuration", "err", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	buf, err := buffer.Open(filepath.Join(cfg.DataDir, "buffer.db"))
	if err != nil {
		slog.Error("open sqlite buffer failed", "err", err)
		os.Exit(1)
	}
	defer buf.Close()

	icmpProber, err := engine.NewICMPProber()
	if err != nil {
		slog.Error("init icmp prober failed", "err", err)
		os.Exit(1)
	}
	defer icmpProber.Close()

	clk := clock.NewTracker()
	client := uplink.NewClient(cfg, buf, clk)
	scheduler := engine.NewScheduler(icmpProber, clk, client.EnqueueSample, client.TriggerAutoMTR)
	client.SetScheduler(scheduler)

	if snap, err := config.LoadSnapshot(cfg.DataDir); err == nil && len(snap.Targets) > 0 {
		slog.Info("loaded offline config snapshot", "targets", len(snap.Targets), "version", snap.ConfigVersion)
		scheduler.ApplyConfig(ctx, snap.Targets)
	}

	slog.Info("smoker probe starting", "central_url", cfg.CentralURL, "data_dir", cfg.DataDir)
	client.Run(ctx)

	scheduler.StopAll()
	slog.Info("smoker probe stopped cleanly")
}
