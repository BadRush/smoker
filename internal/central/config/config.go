package config

import (
	"fmt"
	"os"
	"strings"
)

type CentralConfig struct {
	ListenAddr           string
	DatabaseURL          string
	AdminUsername        string
	AdminPassword        string
	JWTSecret            string
	AppEncryptionKey     string
	CookieSecure         string // auto | true | false
	LocalProbeAutoEnroll bool
	LocalProbeName       string
	LocalProbeLocation   string
	LocalProbeToken      string
	SeedPublicMonitors   bool
	NocTVAllowUnauth     bool
	NocTVKioskToken      string
	PublicBaseURL        string
}

func LoadCentral() (CentralConfig, error) {
	cfg := CentralConfig{
		ListenAddr:           getEnvDefault("LISTEN_ADDR", ":8080"),
		DatabaseURL:          strings.TrimSpace(os.Getenv("DATABASE_URL")),
		AdminUsername:        getEnvDefault("ADMIN_USERNAME", "admin"),
		AdminPassword:        strings.TrimSpace(os.Getenv("ADMIN_PASSWORD")),
		JWTSecret:            strings.TrimSpace(os.Getenv("JWT_SECRET")),
		AppEncryptionKey:     strings.TrimSpace(os.Getenv("APP_ENCRYPTION_KEY")),
		CookieSecure:         strings.ToLower(getEnvDefault("COOKIE_SECURE", "auto")),
		LocalProbeAutoEnroll: strings.EqualFold(getEnvDefault("LOCAL_PROBE_AUTO_ENROLL", "true"), "true"),
		LocalProbeName:       getEnvDefault("LOCAL_PROBE_NAME", "Local Central Probe"),
		LocalProbeLocation:   getEnvDefault("LOCAL_PROBE_LOCATION", "Central Host"),
		LocalProbeToken:      strings.TrimSpace(os.Getenv("LOCAL_PROBE_TOKEN")),
		SeedPublicMonitors:   strings.EqualFold(getEnvDefault("SEED_PUBLIC_MONITORS", "true"), "true"),
		NocTVAllowUnauth:     strings.EqualFold(getEnvDefault("NOC_TV_ALLOW_UNAUTH", "false"), "true"),
		NocTVKioskToken:      strings.TrimSpace(os.Getenv("NOC_TV_KIOSK_TOKEN")),
		PublicBaseURL:        strings.TrimRight(strings.TrimSpace(os.Getenv("PUBLIC_BASE_URL")), "/"),
	}

	if cfg.DatabaseURL == "" {
		return cfg, fmt.Errorf("DATABASE_URL is required")
	}
	if len(cfg.JWTSecret) < 16 {
		return cfg, fmt.Errorf("JWT_SECRET must be at least 16 characters")
	}
	if len(cfg.AppEncryptionKey) < 16 {
		return cfg, fmt.Errorf("APP_ENCRYPTION_KEY must be at least 16 characters")
	}
	if cfg.AdminPassword == "" {
		return cfg, fmt.Errorf("ADMIN_PASSWORD is required for initial bootstrap")
	}
	if cfg.LocalProbeAutoEnroll && cfg.LocalProbeToken == "" {
		return cfg, fmt.Errorf("LOCAL_PROBE_TOKEN is required when LOCAL_PROBE_AUTO_ENROLL=true")
	}
	return cfg, nil
}

func getEnvDefault(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}
