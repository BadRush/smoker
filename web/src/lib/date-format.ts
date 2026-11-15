const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function pad2(n: number): string {
  return String(Math.floor(Math.abs(n))).padStart(2, "0");
}

export function toDate(input: Date | number | string): Date {
  if (input instanceof Date) return input;
  if (typeof input === "number") {
    // Treat 10-digit epochs (< 1e11) as Unix seconds, otherwise milliseconds
    return new Date(input < 1e11 ? input * 1000 : input);
  }
  return new Date(input);
}

export function formatTime24(
  input: Date | number | string,
  includeSeconds = true
): string {
  const d = toDate(input);
  if (Number.isNaN(d.getTime())) return "--:--";
  const hhmm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return includeSeconds ? `${hhmm}:${pad2(d.getSeconds())}` : hhmm;
}

export function formatDateShort(
  input: Date | number | string,
  includeYear = false
): string {
  const d = toDate(input);
  if (Number.isNaN(d.getTime())) return "---";
  const base = `${pad2(d.getDate())} ${MONTHS_SHORT[d.getMonth()]}`;
  return includeYear ? `${base} ${d.getFullYear()}` : base;
}

export function formatDateTime24(
  input: Date | number | string,
  options?: { includeYear?: boolean; includeSeconds?: boolean }
): string {
  const includeYear = options?.includeYear ?? true;
  const includeSeconds = options?.includeSeconds ?? true;
  const d = toDate(input);
  if (Number.isNaN(d.getTime())) return "---";
  return `${formatDateShort(d, includeYear)} · ${formatTime24(d, includeSeconds)}`;
}

export function formatDateSpan24(
  startSec: number | null,
  endSec: number | null
): string {
  if (!startSec || !endSec) {
    return formatDateTime24(new Date());
  }
  const start = toDate(startSec);
  const end = toDate(endSec);
  const sameDay =
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth() &&
    start.getDate() === end.getDate();

  if (sameDay) {
    return `${formatDateShort(start, true)} · ${formatTime24(start)} – ${formatTime24(end)}`;
  }
  return `${formatDateTime24(start)} – ${formatDateTime24(end)}`;
}

function calendarDayKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * Formats uPlot / PNG chart X-axis timestamps strictly in 24h format ("17:00"),
 * attaching short date ("15 Nov") on the first labeled tick and whenever a day changes.
 */
export function formatAxisTicks24(
  splits: Array<number | null | undefined>
): string[] {
  const valid = splits.filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v)
  );
  let minStep = Number.POSITIVE_INFINITY;
  for (let i = 1; i < valid.length; i++) {
    const diff = valid[i] - valid[i - 1];
    if (diff > 0 && diff < minStep) minStep = diff;
  }
  const includeSeconds = minStep < 90;

  let prevDayKey: string | null = null;
  let labeledCount = 0;

  return splits.map((ts) => {
    if (typeof ts !== "number" || !Number.isFinite(ts)) return "";
    const d = toDate(ts);
    const dayKey = calendarDayKey(d);
    const timeStr = formatTime24(d, includeSeconds);
    const needDate = labeledCount === 0 || dayKey !== prevDayKey;
    prevDayKey = dayKey;
    labeledCount++;
    return needDate ? `${timeStr}\n${formatDateShort(d, false)}` : timeStr;
  });
}
