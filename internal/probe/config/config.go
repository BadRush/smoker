package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"smoker/internal/protocol"
)

type ProbeConfig struct {
	CentralURL     string
	ProbeToken     string
	DataDir        string
	MaxBufferMB    int
	MaxBufferHours int
	AgentVersion   string
	TLSSkipVerify  bool
}

func LoadProbe() (ProbeConfig, error) {
	cfg := ProbeConfig{
		CentralURL:     strings.TrimSpace(os.Getenv("CENTRAL_URL")),
		ProbeToken:     strings.TrimSpace(os.Getenv("PROBE_TOKEN")),
		DataDir:        getEnvDefault("DATA_DIR", "/data"),
		MaxBufferMB:    getEnvInt("MAX_BUFFER_MB", 1024),
		MaxBufferHours: getEnvInt("MAX_BUFFER_HOURS", 168),
		AgentVersion:   getEnvDefault("AGENT_VERSION", "1.0.0"),
		TLSSkipVerify:  strings.EqualFold(getEnvDefault("PROBE_TLS_INSECURE_SKIP_VERIFY", "false"), "true"),
	}
	if cfg.CentralURL == "" {
		return cfg, fmt.Errorf("CENTRAL_URL is required")
	}
	if cfg.ProbeToken == "" {
		return cfg, fmt.Errorf("PROBE_TOKEN is required")
	}
	if cfg.MaxBufferMB < 10 {
		cfg.MaxBufferMB = 10
	}
	if cfg.MaxBufferHours < 1 {
		cfg.MaxBufferHours = 1
	}
	if err := os.MkdirAll(cfg.DataDir, 0o755); err != nil {
		return cfg, fmt.Errorf("create DATA_DIR %s: %w", cfg.DataDir, err)
	}
	return cfg, nil
}

func SnapshotPath(dataDir string) string {
	return filepath.Join(dataDir, "config_snapshot.json")
}

func SaveSnapshot(dataDir string, snap protocol.ConfigSyncPayload) error {
	b, err := json.MarshalIndent(snap, "", "  ")
	if err != nil {
		return err
	}
	tmp := SnapshotPath(dataDir) + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, SnapshotPath(dataDir))
}

func LoadSnapshot(dataDir string) (protocol.ConfigSyncPayload, error) {
	b, err := os.ReadFile(SnapshotPath(dataDir))
	if err != nil {
		return protocol.ConfigSyncPayload{}, err
	}
	var snap protocol.ConfigSyncPayload
	if err := json.Unmarshal(b, &snap); err != nil {
		return protocol.ConfigSyncPayload{}, err
	}
	return snap, nil
}

func getEnvDefault(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func getEnvInt(key string, fallback int) int {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}
