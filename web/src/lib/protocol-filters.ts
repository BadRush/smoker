import type { Target, TargetGroup } from "./api";

export type ProtocolFamily = "icmp" | "dns" | "http" | "tcp";
export type IpFamilyFilter = "all" | "ipv4" | "ipv6";
export type GroupByMode = "none" | "protocol" | "group";

export interface ProtocolFamilyMeta {
  id: ProtocolFamily;
  label: string;
  shortLabel: string;
  slideTitle: string;
  description: string;
  badgeClass: string;
}

export const PROTOCOL_FAMILIES: readonly ProtocolFamilyMeta[] = [
  {
    id: "icmp",
    label: "ICMP (Ping)",
    shortLabel: "ICMP",
    slideTitle: "ICMP",
    description: "ICMP & ICMPv6 network path ping",
    badgeClass: "border-emerald-500/40 bg-emerald-500/15 text-emerald-300",
  },
  {
    id: "dns",
    label: "DNS Query",
    shortLabel: "Query (DNS)",
    slideTitle: "DNS QUERY",
    description: "Live DNS & DNS6 resolver lookups",
    badgeClass: "border-cyan-500/40 bg-cyan-500/15 text-cyan-300",
  },
  {
    id: "http",
    label: "HTTP / Web",
    shortLabel: "HTTP",
    slideTitle: "HTTP",
    description: "HTTP / HTTPS & HTTP6 endpoints",
    badgeClass: "border-violet-500/40 bg-violet-500/15 text-violet-300",
  },
  {
    id: "tcp",
    label: "TCP / Port",
    shortLabel: "TCP",
    slideTitle: "TCP",
    description: "TCP & TCP6 socket handshake checks",
    badgeClass: "border-amber-500/40 bg-amber-500/15 text-amber-300",
  },
] as const;

const VALID_PROTOCOLS = new Set<string>(PROTOCOL_FAMILIES.map((p) => p.id));

export function isValidProtocolFamily(value: string): value is ProtocolFamily {
  return VALID_PROTOCOLS.has(value);
}

export function getProtocolFamilyMeta(
  probeType: Target["probe_type"] | string
): ProtocolFamilyMeta {
  const fam = getProtocolFamily(probeType);
  return PROTOCOL_FAMILIES.find((p) => p.id === fam) ?? PROTOCOL_FAMILIES[0];
}

/**
 * Strips redundant trailing protocol parentheticals (e.g. "(ICMP6)", "(Query)")
 * when displayed alongside a dedicated protocol badge.
 */
export function formatCleanTargetTitle(
  name: string,
  probeType: Target["probe_type"] | string
): string {
  const family = getProtocolFamily(probeType);
  let pattern: RegExp;
  switch (family) {
    case "icmp":
      pattern = /\s*\((?:icmp|icmpv?6|ping)\)\s*$/i;
      break;
    case "dns":
      pattern = /\s*\((?:dns|dns6|query|dns\s*query)\)\s*$/i;
      break;
    case "http":
      pattern = /\s*\((?:http|https|http6)\)\s*$/i;
      break;
    case "tcp":
      pattern = /\s*\((?:tcp|tcp6)\)\s*$/i;
      break;
  }
  const cleaned = name.replace(pattern, "").trim();
  return cleaned || name;
}

/**
 * Maps every supported IPv4/IPv6 probe_type into its functional protocol family.
 */
export function getProtocolFamily(
  probeType: Target["probe_type"] | string
): ProtocolFamily {
  const normalized = probeType.toLowerCase();
  if (normalized === "dns" || normalized === "dns6") return "dns";
  if (normalized === "http" || normalized === "http6") return "http";
  if (normalized === "tcp" || normalized === "tcp6") return "tcp";
  return "icmp";
}

/**
 * Returns true if the target uses an IPv6 probe_type or an IPv6 literal/hostname.
 */
export function isIpv6Target(
  target: Pick<Target, "probe_type" | "host">
): boolean {
  if (target.probe_type.toLowerCase().endsWith("6")) return true;
  const host = target.host.trim().toLowerCase();
  if (host.includes("[") && host.includes("]")) {
    if (/^https?:\/\/\[[^\]]*:[^\]]*\]/.test(host)) {
      return true;
    }
  }
  if (!host.startsWith("http://") && !host.startsWith("https://")) {
    const colonCount = (host.match(/:/g) ?? []).length;
    if (colonCount >= 2) return true;
  }
  return host.includes("ipv6");
}

export function matchesProtocolAndIpFilter(
  target: Pick<Target, "probe_type" | "host">,
  protocols: readonly ProtocolFamily[],
  ipVersion: IpFamilyFilter
): boolean {
  if (protocols.length > 0) {
    const family = getProtocolFamily(target.probe_type);
    if (!protocols.includes(family)) return false;
  }
  if (ipVersion === "ipv6") {
    return isIpv6Target(target);
  }
  if (ipVersion === "ipv4") {
    return !isIpv6Target(target);
  }
  return true;
}

export interface ProtocolSection<T> {
  family: ProtocolFamilyMeta;
  items: T[];
}

/**
 * Partitions an item list into non-empty sections ordered by functional protocol family.
 */
export function groupItemsByProtocol<T>(
  items: readonly T[],
  getTarget: (item: T) => Pick<Target, "probe_type">
): ProtocolSection<T>[] {
  const buckets = new Map<ProtocolFamily, T[]>();
  for (const item of items) {
    const fam = getProtocolFamily(getTarget(item).probe_type);
    const list = buckets.get(fam);
    if (list) {
      list.push(item);
    } else {
      buckets.set(fam, [item]);
    }
  }

  const sections: ProtocolSection<T>[] = [];
  for (const meta of PROTOCOL_FAMILIES) {
    const grouped = buckets.get(meta.id);
    if (grouped && grouped.length > 0) {
      sections.push({ family: meta, items: grouped });
    }
  }
  return sections;
}

export interface TargetGroupSection<T> {
  id: string;
  label: string;
  description?: string;
  items: T[];
}

/**
 * Partitions items by configured target group (preserving group order) with Ungrouped last.
 */
export function groupItemsByTargetGroup<T>(
  items: readonly T[],
  getTarget: (item: T) => Pick<Target, "group_id">,
  groups: readonly TargetGroup[]
): TargetGroupSection<T>[] {
  const knownIds = new Set(groups.map((g) => g.id));
  const buckets = new Map<string, T[]>();

  for (const item of items) {
    const gid = getTarget(item).group_id;
    const key = gid && knownIds.has(gid) ? gid : "ungrouped";
    const list = buckets.get(key);
    if (list) {
      list.push(item);
    } else {
      buckets.set(key, [item]);
    }
  }

  const sections: TargetGroupSection<T>[] = [];
  for (const g of groups) {
    const grouped = buckets.get(g.id);
    if (grouped && grouped.length > 0) {
      sections.push({
        id: g.id,
        label: g.name,
        description: g.description,
        items: grouped,
      });
    }
  }

  const ungrouped = buckets.get("ungrouped");
  if (ungrouped && ungrouped.length > 0) {
    sections.push({
      id: "ungrouped",
      label: "Ungrouped / Custom",
      description: "Targets not assigned to a specific group",
      items: ungrouped,
    });
  }

  return sections;
}
