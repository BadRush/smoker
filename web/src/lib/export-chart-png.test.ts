import { describe, expect, it, vi } from "vitest";
import {
  buildEvidenceFilename,
  computeSeriesSummary,
  DEFAULT_EVIDENCE_BRAND_NAME,
  drawVectorSmokePlot,
  formatEvidenceSpan,
  getEvidenceBrandName,
  saveEvidenceBrandName,
} from "./export-chart-png";

describe("export-chart-png helpers", () => {
  it("falls back to 'Smoker by anamBadrus' when brand name is empty and persists custom brand name", () => {
    window.localStorage.clear();
    expect(DEFAULT_EVIDENCE_BRAND_NAME).toBe("Smoker by anamBadrus");
    expect(getEvidenceBrandName()).toBe("Smoker by anamBadrus");

    saveEvidenceBrandName("  Varnion Technology Semesta  ");
    expect(getEvidenceBrandName()).toBe("Varnion Technology Semesta");

    saveEvidenceBrandName("   ");
    expect(getEvidenceBrandName()).toBe("Smoker by anamBadrus");
  });

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

  it("renders both left latency (ms) and right packet loss (0%..100%) axes on exported PNG plots", () => {
    const texts: Array<{ text: string; x: number; y: number }> = [];
    const ctx = {
      strokeStyle: "#000",
      fillStyle: "#000",
      lineWidth: 1,
      lineCap: "butt",
      lineJoin: "miter",
      font: "",
      textAlign: "left",
      textBaseline: "alphabetic",
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      closePath: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      arc: vi.fn(),
      fillRect: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      setLineDash: vi.fn(),
      fillText: vi.fn((text: string, x: number, y: number) => {
        texts.push({ text, x, y });
      }),
    } as unknown as CanvasRenderingContext2D;

    const geom = drawVectorSmokePlot(
      ctx,
      {
        probe_id: "p1",
        probe_name: "Local",
        location_label: "DC1",
        timestamps: [1700000000, 1700000060],
        min_ms: [4, 5],
        p25_ms: [5, 6],
        p50_ms: [6, 7],
        p75_ms: [7, 8],
        p95_ms: [8, 9],
        max_ms: [9, 10],
        jitter_ms: [0.5, 0.5],
        loss_pct: [0, 50],
      },
      20,
      66,
      800,
      264,
      20
    );

    const rightLabels = texts.filter((t) => t.x > geom.gRight);
    expect(rightLabels.map((t) => t.text)).toEqual(["0%", "25%", "50%", "75%", "100%"]);
    const leftLabels = texts.filter((t) => t.x < geom.gLeft);
    expect(leftLabels.some((t) => t.text.endsWith("ms"))).toBe(true);
  });
});
