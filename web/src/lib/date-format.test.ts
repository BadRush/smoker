import { describe, expect, it } from "vitest";
import {
  formatAxisTicks24,
  formatDateSpan24,
  formatDateTime24,
  formatTime24,
} from "./date-format";

describe("date-format 24h helpers", () => {
  it("formats 24h clock and date consistently without AM/PM", () => {
    const sample = new Date(2026, 10, 15, 19, 23, 45);
    expect(formatTime24(sample)).toBe("19:23:45");
    expect(formatTime24(sample, false)).toBe("19:23");
    expect(formatDateTime24(sample)).toBe("15 Nov 2026 · 19:23:45");
    expect(formatDateTime24(sample, { includeYear: false })).toBe("15 Nov · 19:23:45");
    expect(formatDateTime24(sample)).not.toMatch(/am|pm/i);
  });

  it("formats same-day and cross-midnight timestamp spans cleanly", () => {
    const t1 = Math.floor(new Date(2026, 10, 15, 16, 47, 30).getTime() / 1000);
    const t2 = Math.floor(new Date(2026, 10, 15, 19, 23, 44).getTime() / 1000);
    expect(formatDateSpan24(t1, t2)).toBe("15 Nov 2026 · 16:47:30 – 19:23:44");

    const tPrev = Math.floor(new Date(2026, 10, 14, 22, 15, 0).getTime() / 1000);
    expect(formatDateSpan24(tPrev, t2)).toBe(
      "14 Nov 2026 · 22:15:00 – 15 Nov 2026 · 19:23:44"
    );
  });

  it("formats chart X-axis ticks in 24h with date on first tick and midnight rollover", () => {
    const base = [
      new Date(2026, 10, 15, 23, 0, 0),
      new Date(2026, 10, 15, 23, 30, 0),
      new Date(2026, 10, 16, 0, 0, 0),
      new Date(2026, 10, 16, 0, 30, 0),
    ].map((d) => Math.floor(d.getTime() / 1000));

    const labels = formatAxisTicks24(base);
    expect(labels).toEqual([
      "23:00\n15 Nov",
      "23:30",
      "00:00\n16 Nov",
      "00:30",
    ]);
  });
});
