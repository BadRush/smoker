package db

import (
	"context"
	"strings"

	"github.com/google/uuid"
)

type SeedResult struct {
	GroupsCreated  int `json:"groups_created"`
	TargetsCreated int `json:"targets_created"`
}

type starterGroupSpec struct {
	Name        string
	Description string
	SortOrder   int
}

type starterTargetSpec struct {
	GroupName   string
	Name        string
	Host        string
	ProbeType   string
	PortOrPath  string
	IntervalSec int
	TimeoutMs   int
}

var starterGroups = []starterGroupSpec{
	{
		Name:        "Public DNS",
		Description: "Anycast public DNS resolvers monitored via ICMP and live UDP DNS lookup latency",
		SortOrder:   1,
	},
	{
		Name:        "Public Apps",
		Description: "Major cloud, search, messaging, developer & productivity platforms",
		SortOrder:   2,
	},
}

var starterTargets = []starterTargetSpec{
	// Public DNS (Google, Cloudflare, Quad9, OpenDNS, AdGuard)
	{GroupName: "Public DNS", Name: "Google DNS (ICMP)", Host: "8.8.8.8", ProbeType: "icmp", IntervalSec: 1, TimeoutMs: 1000},
	{GroupName: "Public DNS", Name: "Google DNS (Query)", Host: "8.8.8.8", ProbeType: "dns", PortOrPath: "google.com|A", IntervalSec: 2, TimeoutMs: 1500},
	{GroupName: "Public DNS", Name: "Cloudflare DNS (ICMP)", Host: "1.1.1.1", ProbeType: "icmp", IntervalSec: 1, TimeoutMs: 1000},
	{GroupName: "Public DNS", Name: "Cloudflare DNS (Query)", Host: "1.1.1.1", ProbeType: "dns", PortOrPath: "cloudflare.com|A", IntervalSec: 2, TimeoutMs: 1500},
	{GroupName: "Public DNS", Name: "Quad9 DNS (ICMP)", Host: "9.9.9.9", ProbeType: "icmp", IntervalSec: 2, TimeoutMs: 1500},
	{GroupName: "Public DNS", Name: "Quad9 DNS (Query)", Host: "9.9.9.9", ProbeType: "dns", PortOrPath: "quad9.net|A", IntervalSec: 2, TimeoutMs: 1500},
	{GroupName: "Public DNS", Name: "OpenDNS (Query)", Host: "208.67.222.222", ProbeType: "dns", PortOrPath: "opendns.com|A", IntervalSec: 2, TimeoutMs: 1500},
	{GroupName: "Public DNS", Name: "AdGuard DNS (Query)", Host: "94.140.14.14", ProbeType: "dns", PortOrPath: "adguard.com|A", IntervalSec: 2, TimeoutMs: 1500},

	// Public Apps (Search, Cloud, Messaging, Collaboration, Dev/AI)
	{GroupName: "Public Apps", Name: "Google Search", Host: "https://www.google.com/generate_204", ProbeType: "http", IntervalSec: 5, TimeoutMs: 3000},
	{GroupName: "Public Apps", Name: "YouTube", Host: "https://www.youtube.com/generate_204", ProbeType: "http", IntervalSec: 5, TimeoutMs: 3000},
	{GroupName: "Public Apps", Name: "Cloudflare Edge", Host: "https://1.1.1.1/cdn-cgi/trace", ProbeType: "http", IntervalSec: 5, TimeoutMs: 3000},
	{GroupName: "Public Apps", Name: "WhatsApp Web", Host: "https://web.whatsapp.com/", ProbeType: "http", IntervalSec: 5, TimeoutMs: 3000},
	{GroupName: "Public Apps", Name: "Discord API", Host: "https://discord.com/api/v10/gateway", ProbeType: "http", IntervalSec: 5, TimeoutMs: 3000},
	{GroupName: "Public Apps", Name: "Slack API", Host: "https://slack.com/api/api.test", ProbeType: "http", IntervalSec: 5, TimeoutMs: 3000},
	{GroupName: "Public Apps", Name: "Microsoft", Host: "https://www.microsoft.com/", ProbeType: "http", IntervalSec: 5, TimeoutMs: 4000},
	{GroupName: "Public Apps", Name: "Wikipedia", Host: "https://en.wikipedia.org/wiki/Main_Page", ProbeType: "http", IntervalSec: 5, TimeoutMs: 3000},
	{GroupName: "Public Apps", Name: "GitHub (TLS 443)", Host: "github.com", ProbeType: "tcp", PortOrPath: "443", IntervalSec: 2, TimeoutMs: 2000},
	{GroupName: "Public Apps", Name: "OpenAI API (TLS 443)", Host: "api.openai.com", ProbeType: "tcp", PortOrPath: "443", IntervalSec: 2, TimeoutMs: 2000},
}

func targetSeedKey(name, host, probeType string) string {
	return strings.ToLower(strings.TrimSpace(name)) + "\x00" +
		strings.ToLower(strings.TrimSpace(host)) + "\x00" +
		strings.ToLower(strings.TrimSpace(probeType))
}

// SeedPublicMonitors inserts starter Public DNS & Public Apps groups and targets.
// When onlyIfEmpty is true, seeding is skipped if any groups or targets already exist.
func (s *Store) SeedPublicMonitors(ctx context.Context, onlyIfEmpty bool) (SeedResult, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return SeedResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if onlyIfEmpty {
		var hasAny bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS(SELECT 1 FROM targets) OR EXISTS(SELECT 1 FROM target_groups)
		`).Scan(&hasAny); err != nil {
			return SeedResult{}, err
		}
		if hasAny {
			return SeedResult{}, nil
		}
	}

	groupMap := make(map[string]uuid.UUID, len(starterGroups))
	gRows, err := tx.Query(ctx, `SELECT id, name FROM target_groups`)
	if err != nil {
		return SeedResult{}, err
	}
	for gRows.Next() {
		var id uuid.UUID
		var name string
		if err := gRows.Scan(&id, &name); err != nil {
			gRows.Close()
			return SeedResult{}, err
		}
		groupMap[strings.ToLower(strings.TrimSpace(name))] = id
	}
	if err := gRows.Err(); err != nil {
		gRows.Close()
		return SeedResult{}, err
	}
	gRows.Close()

	var res SeedResult
	for _, g := range starterGroups {
		key := strings.ToLower(g.Name)
		if _, exists := groupMap[key]; exists {
			continue
		}
		id := newUUIDv7()
		if _, err := tx.Exec(ctx, `
			INSERT INTO target_groups (id, name, description, sort_order)
			VALUES ($1, $2, $3, $4)
		`, id, g.Name, g.Description, g.SortOrder); err != nil {
			return SeedResult{}, err
		}
		groupMap[key] = id
		res.GroupsCreated++
	}

	existingTargets := make(map[string]bool)
	tRows, err := tx.Query(ctx, `SELECT name, host, probe_type FROM targets`)
	if err != nil {
		return SeedResult{}, err
	}
	for tRows.Next() {
		var name, host, ptype string
		if err := tRows.Scan(&name, &host, &ptype); err != nil {
			tRows.Close()
			return SeedResult{}, err
		}
		existingTargets[targetSeedKey(name, host, ptype)] = true
	}
	if err := tRows.Err(); err != nil {
		tRows.Close()
		return SeedResult{}, err
	}
	tRows.Close()

	for _, t := range starterTargets {
		key := targetSeedKey(t.Name, t.Host, t.ProbeType)
		if existingTargets[key] {
			continue
		}
		var groupID *uuid.UUID
		if gid, ok := groupMap[strings.ToLower(t.GroupName)]; ok {
			gCopy := gid
			groupID = &gCopy
		}
		id := newUUIDv7()
		if _, err := tx.Exec(ctx, `
			INSERT INTO targets (
				id, group_id, name, host, probe_type, port_or_path,
				interval_sec, timeout_ms, enabled, auto_mtr_on_loss,
				mtr_loss_threshold, assign_all_probes
			)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, TRUE, 3, TRUE)
		`, id, groupID, t.Name, t.Host, t.ProbeType, t.PortOrPath, t.IntervalSec, t.TimeoutMs); err != nil {
			return SeedResult{}, err
		}
		existingTargets[key] = true
		res.TargetsCreated++
	}

	if err := tx.Commit(ctx); err != nil {
		return SeedResult{}, err
	}
	return res, nil
}
