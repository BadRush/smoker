package config

import (
	"encoding/json"
	"fmt"
	"net"
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
	SourceIP4      net.IP
	SourceIP6      net.IP
}

func parseSourceIPConfig() (src4, src6 net.IP, err error) {
	if raw := strings.TrimSpace(os.Getenv("SOURCE_IP")); raw != "" {
		ip := net.ParseIP(raw)
		if ip == nil {
			return nil, nil, fmt.Errorf("invalid SOURCE_IP %q", raw)
		}
		if v4 := ip.To4(); v4 != nil {
			src4 = v4
		} else {
			src6 = ip.To16()
		}
	}
	if raw4 := strings.TrimSpace(os.Getenv("SOURCE_IP4")); raw4 != "" {
		ip := net.ParseIP(raw4)
		if ip == nil || ip.To4() == nil {
			return nil, nil, fmt.Errorf("invalid SOURCE_IP4 %q (expected IPv4 address)", raw4)
		}
		src4 = ip.To4()
	}
	if raw6 := strings.TrimSpace(os.Getenv("SOURCE_IP6")); raw6 != "" {
		ip := net.ParseIP(raw6)
		if ip == nil || ip.To4() != nil || ip.To16() == nil {
			return nil, nil, fmt.Errorf("invalid SOURCE_IP6 %q (expected IPv6 address)", raw6)
		}
		src6 = ip.To16()
	}
	return src4, src6, nil
}

func LoadProbe() (ProbeConfig, error) {
	src4, src6, err := parseSourceIPConfig()
	if err != nil {
		return ProbeConfig{}, err
	}
	cfg := ProbeConfig{
		CentralURL:     strings.TrimSpace(os.Getenv("CENTRAL_URL")),
		ProbeToken:     strings.TrimSpace(os.Getenv("PROBE_TOKEN")),
		DataDir:        getEnvDefault("DATA_DIR", "/data"),
		MaxBufferMB:    getEnvInt("MAX_BUFFER_MB", 1024),
		MaxBufferHours: getEnvInt("MAX_BUFFER_HOURS", 168),
		AgentVersion:   getEnvDefault("AGENT_VERSION", "1.0.0"),
		TLSSkipVerify:  strings.EqualFold(getEnvDefault("PROBE_TLS_INSECURE_SKIP_VERIFY", "false"), "true"),
		SourceIP4:      src4,
		SourceIP6:      src6,
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
