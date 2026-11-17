package config

import "testing"

func TestLoadProbeSourceIPParsing(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CENTRAL_URL", "wss://smoker.example.com/ws/probe")
	t.Setenv("PROBE_TOKEN", "smk_test_token")
	t.Setenv("DATA_DIR", dir)

	// Dual-stack explicit SOURCE_IP (IPv4) + SOURCE_IP6 (IPv6)
	t.Setenv("SOURCE_IP", "10.20.30.40")
	t.Setenv("SOURCE_IP4", "")
	t.Setenv("SOURCE_IP6", "2001:db8::40")
	cfg, err := LoadProbe()
	if err != nil {
		t.Fatalf("LoadProbe dual-stack failed: %v", err)
	}
	if cfg.SourceIP4.String() != "10.20.30.40" {
		t.Fatalf("SourceIP4 = %v, want 10.20.30.40", cfg.SourceIP4)
	}
	if cfg.SourceIP6.String() != "2001:db8::40" {
		t.Fatalf("SourceIP6 = %v, want 2001:db8::40", cfg.SourceIP6)
	}

	// SOURCE_IP accepting IPv6 directly when SOURCE_IP6 unset
	t.Setenv("SOURCE_IP", "2001:db8::99")
	t.Setenv("SOURCE_IP4", "192.168.10.201")
	t.Setenv("SOURCE_IP6", "")
	cfg, err = LoadProbe()
	if err != nil {
		t.Fatalf("LoadProbe SOURCE_IP v6 + SOURCE_IP4 failed: %v", err)
	}
	if cfg.SourceIP4.String() != "192.168.10.201" || cfg.SourceIP6.String() != "2001:db8::99" {
		t.Fatalf("unexpected source IPs: v4=%v v6=%v", cfg.SourceIP4, cfg.SourceIP6)
	}

	// Reject invalid IP
	t.Setenv("SOURCE_IP", "not-an-ip")
	t.Setenv("SOURCE_IP4", "")
	if _, err := LoadProbe(); err == nil {
		t.Fatalf("expected error for invalid SOURCE_IP")
	}

	// Reject IPv6 in SOURCE_IP4
	t.Setenv("SOURCE_IP", "")
	t.Setenv("SOURCE_IP4", "2001:db8::1")
	if _, err := LoadProbe(); err == nil {
		t.Fatalf("expected error for IPv6 literal in SOURCE_IP4")
	}

	// Reject IPv4 in SOURCE_IP6
	t.Setenv("SOURCE_IP4", "")
	t.Setenv("SOURCE_IP6", "10.0.0.1")
	if _, err := LoadProbe(); err == nil {
		t.Fatalf("expected error for IPv4 literal in SOURCE_IP6")
	}
}
