package db

import (
	"strconv"
	"testing"
)

func TestStarterCatalogIntegrity(t *testing.T) {
	t.Parallel()

	groups := make(map[string]bool, len(starterGroups))
	for _, g := range starterGroups {
		if g.Name == "" {
			t.Fatal("starter group name must not be empty")
		}
		if groups[g.Name] {
			t.Fatalf("duplicate starter group %q", g.Name)
		}
		groups[g.Name] = true
	}

	seenTargets := make(map[string]bool, len(starterTargets))
	for _, spec := range starterTargets {
		if !groups[spec.GroupName] {
			t.Fatalf("target %q references unknown starter group %q", spec.Name, spec.GroupName)
		}
		if spec.Name == "" || spec.Host == "" {
			t.Fatalf("target %+v missing name or host", spec)
		}
		switch spec.ProbeType {
		case "icmp", "http", "dns":
		case "tcp":
			p, err := strconv.Atoi(spec.PortOrPath)
			if err != nil || p < 1 || p > 65535 {
				t.Fatalf("tcp target %q invalid port %q", spec.Name, spec.PortOrPath)
			}
		default:
			t.Fatalf("target %q invalid probe_type %q", spec.Name, spec.ProbeType)
		}
		if spec.IntervalSec < 1 || spec.IntervalSec > 300 {
			t.Fatalf("target %q invalid interval_sec %d", spec.Name, spec.IntervalSec)
		}
		if spec.TimeoutMs < 100 || spec.TimeoutMs > 10000 {
			t.Fatalf("target %q invalid timeout_ms %d", spec.Name, spec.TimeoutMs)
		}
		key := targetSeedKey(spec.Name, spec.Host, spec.ProbeType)
		if seenTargets[key] {
			t.Fatalf("duplicate starter target key %q", key)
		}
		seenTargets[key] = true
	}
}
