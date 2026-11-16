import type { Target, TargetGroup } from "./api";
import {
  groupItemsByProtocol,
  groupItemsByTargetGroup,
  isValidProtocolFamily,
  matchesProtocolAndIpFilter,
  PROTOCOL_FAMILIES,
  getProtocolFamily,
  type GroupByMode,
  type IpFamilyFilter,
  type ProtocolFamily,
} from "./protocol-filters";

export type TargetStatusFilter = "all" | "active" | "paused" | "vip" | "auto_mtr";
export type TargetSortOption =
  | "name_asc"
  | "name_desc"
  | "protocol"
  | "interval_asc"
  | "newest"
  | "oldest";
export type TargetPageSize = 10 | 20 | 50 | 100 | 0;

export const PAGE_SIZE_OPTIONS: ReadonlyArray<{ value: TargetPageSize; label: string }> = [
  { value: 10, label: "10 / page" },
  { value: 20, label: "20 / page" },
  { value: 50, label: "50 / page" },
  { value: 100, label: "100 / page" },
  { value: 0, label: "All" },
];

export interface TargetTableFilters {
  q: string;
  group: string;
  protocols: ProtocolFamily[];
  ipVersion: IpFamilyFilter;
  status: TargetStatusFilter;
  probeId: string;
  groupBy: GroupByMode;
  sortBy: TargetSortOption;
  page: number;
  pageSize: TargetPageSize;
}

export const DEFAULT_TARGET_FILTERS: TargetTableFilters = {
  q: "",
  group: "all",
  protocols: [],
  ipVersion: "all",
  status: "all",
  probeId: "all",
  groupBy: "protocol",
  sortBy: "name_asc",
  page: 1,
  pageSize: 20,
};

const VALID_STATUS = new Set<string>(["all", "active", "paused", "vip", "auto_mtr"]);
const VALID_GROUP_BY = new Set<string>(["none", "protocol", "group"]);
const VALID_SORT = new Set<string>([
  "name_asc",
  "name_desc",
  "protocol",
  "interval_asc",
  "newest",
  "oldest",
]);
const VALID_PAGE_SIZES = new Set<number>([0, 10, 20, 50, 100]);
const PROTOCOL_ORDER = new Map<ProtocolFamily, number>(
  PROTOCOL_FAMILIES.map((m, idx) => [m.id, idx])
);

export function parseTargetTableFilters(search: string): TargetTableFilters {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  const params = new URLSearchParams(raw);

  const q = params.get("q") ?? "";
  const group = params.get("group")?.trim() || "all";

  const protocols: ProtocolFamily[] = [];
  const seenProto = new Set<ProtocolFamily>();
  for (const part of (params.get("proto") ?? "").split(",")) {
    const clean = part.trim().toLowerCase();
    if (isValidProtocolFamily(clean) && !seenProto.has(clean)) {
      seenProto.add(clean);
      protocols.push(clean);
    }
  }

  const ipRaw = (params.get("ip") ?? "").trim().toLowerCase();
  const ipVersion: IpFamilyFilter =
    ipRaw === "ipv4" || ipRaw === "ipv6" ? ipRaw : "all";

  const statusRaw = (params.get("status") ?? "").trim();
  const status: TargetStatusFilter = VALID_STATUS.has(statusRaw)
    ? (statusRaw as TargetStatusFilter)
    : DEFAULT_TARGET_FILTERS.status;

  const probeId = params.get("probe")?.trim() || "all";

  const groupByRaw = (params.get("groupBy") ?? "").trim();
  const groupBy: GroupByMode = VALID_GROUP_BY.has(groupByRaw)
    ? (groupByRaw as GroupByMode)
    : DEFAULT_TARGET_FILTERS.groupBy;

  const sortRaw = (params.get("sort") ?? "").trim();
  const sortBy: TargetSortOption = VALID_SORT.has(sortRaw)
    ? (sortRaw as TargetSortOption)
    : DEFAULT_TARGET_FILTERS.sortBy;

  const pageNum = Number(params.get("page"));
  const page = Number.isInteger(pageNum) && pageNum >= 1 ? pageNum : 1;

  const limitRaw = params.get("limit");
  const limitNum = limitRaw === "all" ? 0 : Number(limitRaw);
  const pageSize: TargetPageSize =
    limitRaw !== null && VALID_PAGE_SIZES.has(limitNum)
      ? (limitNum as TargetPageSize)
      : DEFAULT_TARGET_FILTERS.pageSize;

  return {
    q,
    group,
    protocols,
    ipVersion,
    status,
    probeId,
    groupBy,
    sortBy,
    page,
    pageSize,
  };
}

export function serializeTargetTableFilters(
  filters: TargetTableFilters,
  existingSearch = ""
): string {
  const raw = existingSearch.startsWith("?")
    ? existingSearch.slice(1)
    : existingSearch;
  const params = new URLSearchParams();
  const prev = new URLSearchParams(raw);
  const editParam = prev.get("edit");
  if (editParam) {
    params.set("edit", editParam);
  }

  if (filters.q.trim()) params.set("q", filters.q.trim());
  if (filters.group !== "all") params.set("group", filters.group);
  if (filters.protocols.length > 0) params.set("proto", filters.protocols.join(","));
  if (filters.ipVersion !== "all") params.set("ip", filters.ipVersion);
  if (filters.status !== "all") params.set("status", filters.status);
  if (filters.probeId !== "all") params.set("probe", filters.probeId);
  if (filters.groupBy !== DEFAULT_TARGET_FILTERS.groupBy) {
    params.set("groupBy", filters.groupBy);
  }
  if (filters.sortBy !== DEFAULT_TARGET_FILTERS.sortBy) {
    params.set("sort", filters.sortBy);
  }
  if (filters.page > 1) params.set("page", String(filters.page));
  if (filters.pageSize !== DEFAULT_TARGET_FILTERS.pageSize) {
    params.set("limit", filters.pageSize === 0 ? "all" : String(filters.pageSize));
  }
  return params.toString();
}

export function hasActiveTargetFilters(filters: TargetTableFilters): boolean {
  return (
    Boolean(filters.q.trim()) ||
    filters.group !== "all" ||
    filters.protocols.length > 0 ||
    filters.ipVersion !== "all" ||
    filters.status !== "all" ||
    filters.probeId !== "all"
  );
}

export function matchesStatusAndProbe(
  target: Target,
  status: TargetStatusFilter,
  probeId: string
): boolean {
  switch (status) {
    case "active":
      if (!target.enabled) return false;
      break;
    case "paused":
      if (target.enabled) return false;
      break;
    case "vip":
      if (!target.pinned_on_tv) return false;
      break;
    case "auto_mtr":
      if (!target.auto_mtr_on_loss) return false;
      break;
  }

  if (probeId === "assign_all") {
    return target.assign_all_probes;
  }
  if (probeId === "custom") {
    return !target.assign_all_probes;
  }
  if (probeId !== "all") {
    return target.assign_all_probes || target.probe_ids.includes(probeId);
  }
  return true;
}

export function filterAndSortTargets(
  targets: readonly Target[],
  groupMap: ReadonlyMap<string, string>,
  filters: Pick<
    TargetTableFilters,
    "q" | "group" | "protocols" | "ipVersion" | "status" | "probeId" | "sortBy"
  >
): Target[] {
  const q = filters.q.trim().toLowerCase();

  const filtered = targets.filter((t) => {
    if (filters.group !== "all" && (t.group_id ?? "ungrouped") !== filters.group) {
      return false;
    }
    if (!matchesProtocolAndIpFilter(t, filters.protocols, filters.ipVersion)) {
      return false;
    }
    if (!matchesStatusAndProbe(t, filters.status, filters.probeId)) {
      return false;
    }
    if (q) {
      const gName = t.group_id
        ? (groupMap.get(t.group_id) ?? "").toLowerCase()
        : "ungrouped";
      const portOrPath = (t.port_or_path ?? "").toLowerCase();
      const matched =
        t.name.toLowerCase().includes(q) ||
        t.host.toLowerCase().includes(q) ||
        t.probe_type.toLowerCase().includes(q) ||
        portOrPath.includes(q) ||
        gName.includes(q);
      if (!matched) return false;
    }
    return true;
  });

  return [...filtered].sort((a, b) => {
    switch (filters.sortBy) {
      case "name_desc":
        return b.name.localeCompare(a.name);
      case "protocol": {
        const famDiff =
          (PROTOCOL_ORDER.get(getProtocolFamily(a.probe_type)) ?? 0) -
          (PROTOCOL_ORDER.get(getProtocolFamily(b.probe_type)) ?? 0);
        if (famDiff !== 0) return famDiff;
        const typeDiff = a.probe_type.localeCompare(b.probe_type);
        if (typeDiff !== 0) return typeDiff;
        return a.name.localeCompare(b.name);
      }
      case "interval_asc": {
        if (a.interval_sec !== b.interval_sec) {
          return a.interval_sec - b.interval_sec;
        }
        return a.name.localeCompare(b.name);
      }
      case "newest":
        return b.created_at.localeCompare(a.created_at) || a.name.localeCompare(b.name);
      case "oldest":
        return a.created_at.localeCompare(b.created_at) || a.name.localeCompare(b.name);
      case "name_asc":
      default:
        return a.name.localeCompare(b.name);
    }
  });
}

/**
 * Aligns overall list ordering with the chosen grouping mode prior to pagination
 * so rows within each category/group remain contiguous across page boundaries.
 */
export function orderTargetsForSections(
  sortedTargets: readonly Target[],
  groups: readonly TargetGroup[],
  groupBy: GroupByMode
): Target[] {
  if (groupBy === "protocol") {
    return groupItemsByProtocol(sortedTargets, (t) => t).flatMap((s) => s.items);
  }
  if (groupBy === "group") {
    return groupItemsByTargetGroup(sortedTargets, (t) => t, groups).flatMap(
      (s) => s.items
    );
  }
  return [...sortedTargets];
}

export interface PaginatedResult<T> {
  pageItems: T[];
  safePage: number;
  totalPages: number;
  totalItems: number;
  startIdx: number;
  endIdx: number;
}

export function paginateItems<T>(
  items: readonly T[],
  page: number,
  pageSize: TargetPageSize
): PaginatedResult<T> {
  const totalItems = items.length;
  if (totalItems === 0) {
    return {
      pageItems: [],
      safePage: 1,
      totalPages: 1,
      totalItems: 0,
      startIdx: 0,
      endIdx: 0,
    };
  }

  if (pageSize === 0) {
    return {
      pageItems: [...items],
      safePage: 1,
      totalPages: 1,
      totalItems,
      startIdx: 1,
      endIdx: totalItems,
    };
  }

  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const startOffset = (safePage - 1) * pageSize;
  const endOffset = Math.min(totalItems, startOffset + pageSize);

  return {
    pageItems: items.slice(startOffset, endOffset),
    safePage,
    totalPages,
    totalItems,
    startIdx: startOffset + 1,
    endIdx: endOffset,
  };
}

export function computeVisiblePageNumbers(
  currentPage: number,
  totalPages: number
): Array<number | "ellipsis"> {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }

  const pages: Array<number | "ellipsis"> = [1];
  const left = Math.max(2, currentPage - 1);
  const right = Math.min(totalPages - 1, currentPage + 1);

  if (left > 2) pages.push("ellipsis");
  for (let p = left; p <= right; p++) {
    pages.push(p);
  }
  if (right < totalPages - 1) pages.push("ellipsis");
  pages.push(totalPages);
  return pages;
}
