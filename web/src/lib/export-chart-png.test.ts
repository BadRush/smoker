import { describe, expect, it } from "vitest";
import {
  buildEvidenceFilename,
  computeSeriesSummary,
  formatEvidenceSpan,
} from "./export-chart-png";

describe("export-chart-png helpers", () => {
  it("computes BEST, NORMAL, HIGH, JITTER, and AVG LOSS summary across buckets", () => {
    const summary = computeSeriesSummary({
      probe_id: "p1",
      probe_name: "probe-local",
      location_label: "Local",
      timestamps: [1700000000, 1700000060, 1700000120],
      min_ms: [10, 8, null],
      p25_ms: [12, 10, null],
      p50_ms: [15, 11, null],
      p75_ms: [18, 14, null],
      p95_ms: [24, 30, null],
      max_ms: [28, 35, null],
      jitter_ms: [1.5, 2.5, null],
      loss_pct: [0, 10, 20],
    });

    expect(summary.bestMs).toBe(8);
    expect(summary.normalMs).toBeCloseTo(13, 3);
    expect(summary.highMs).toBe(30);
    expect(summary.jitterMs).toBeCloseTo(2, 3);
    expect(summary.lossPct).toBeCloseTo(10, 3);
    expect(summary.startTs).toBe(1700000000);
    expect(summary.endTs).toBe(1700000120);
  });

  it("builds probe-free PNG evidence filenames and 24h dated time spans", () => {
    const name = buildEvidenceFilename(
      "Google Public DNS",
      "3h",
      new Date(2026, 10, 15, 14, 5, 9)
    );
    expect(name).toBe("smoker-google-public-dns-3h-20261115-140509.png");

    const t1 = Math.floor(new Date(2026, 10, 15, 16, 47, 30).getTime() / 1000);
    const t2 = Math.floor(new Date(2026, 10, 15, 19, 23, 44).getTime() / 1000);
    const span = formatEvidenceSpan(t1, t2);
    expect(span).toBe("15 Nov 2026 · 16:47:30 – 19:23:44");
    expect(span).not.toMatch(/am|pm/i);
  });
});
