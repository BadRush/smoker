import { describe, expect, it } from "vitest";
import {
  appendLiveTick,
  appendSparkPoint,
  classifySampleSeverity,
  computeChartYUpper,
  formatLoss,
  formatMs,
  resolveEffectiveWarnMs,
  sparklineToProbeSeries,
  statusVisuals,
  worseSeverity,
  type ProbeSeriesInput,
} from "./smoke-math";

describe("smoke-math helpers", () => {
  it("formats latency and loss cleanly", () => {
    expect(formatMs(null)).toBe("—");
    expect(formatMs(0.45)).toBe("0.45 ms");
    expect(formatMs(12.34)).toBe("12.3 ms");
    expect(formatMs(142.8)).toBe("143 ms");
    expect(formatLoss(2.34)).toBe("2.3%");
  });

  it("maps matrix statuses with distinct labels and classes", () => {
    expect(statusVisuals("healthy").label).toBe("OK");
    expect(statusVisuals("down").label).toBe("DOWN");
    expect(statusVisuals("loss").label).toBe("LOSS");
  });

  it("appends live ticks and trims samples older than maxWindowSec", () => {
    const base: ProbeSeriesInput = {
      probe_id: "p1",
      probe_name: "Local",
      location_label: "DC1",
      timestamps: [100, 200],
      min_ms: [10, 12],
      p25_ms: [10, 12],
      p50_ms: [10, 12],
      p75_ms: [10, 12],
      p95_ms: [10, 12],
      max_ms: [10, 12],
      jitter_ms: [0, 2],
      loss_pct: [0, 0],
    };

    const next = appendLiveTick(base, 450, null, null, true, 300);
    // 100 < 450 - 300 (150), so timestamp 100 is trimmed
    expect(next.timestamps).toEqual([200, 450]);
    expect(next.p50_ms).toEqual([12, null]);
    expect(next.loss_pct).toEqual([0, 100]);
  });

  it("coalesces same-second sparkline points, bounds maxPoints, and converts to ProbeSeriesInput", () => {
    let pts = appendSparkPoint([], { ts: 10, min: 4, p50: 5, p95: 8, loss: 0 }, 3);
    pts = appendSparkPoint(pts, { ts: 10, min: 3, p50: 6, p95: 9, loss: 0 }, 3);
    pts = appendSparkPoint(pts, { ts: 20, min: 5, p50: 7, p95: 10, loss: 10 }, 3);
    pts = appendSparkPoint(pts, { ts: 30, min: null, p50: null, p95: null, loss: 100 }, 3);
    pts = appendSparkPoint(pts, { ts: 40, min: 6, p50: 8, p95: 12, loss: 0 }, 3);

    expect(pts.map((p) => p.ts)).toEqual([20, 30, 40]);

    const series = sparklineToProbeSeries("p1", "Local", "DC1", pts, 1.5);
    expect(series.timestamps).toEqual([20, 30, 40]);
    expect(series.p25_ms).toEqual([6, null, 7]);
    expect(series.p75_ms).toEqual([8.5, null, 10]);
    expect(series.jitter_ms).toEqual([1.5, null, 1.5]);
    expect(series.loss_pct).toEqual([10, 100, 0]);
  });

  it("classifies normal, warn (threshold or intermittent loss), and critical (>=50% loss) samples", () => {
    expect(classifySampleSeverity({ p50: 10, p95: 14, lossPct: 0, warnMs: 25 })).toBe("normal");
    // Touching P50 threshold -> warn (yellow)
    expect(classifySampleSeverity({ p50: 25, p95: 28, lossPct: 0, warnMs: 25 })).toBe("warn");
    // Touching P95 >= warnMs * 1.25 -> warn (yellow)
    expect(classifySampleSeverity({ p50: 18, p95: 31.25, lossPct: 0, warnMs: 25 })).toBe("warn");
    // Intermittent loss (0 < loss < 50) -> warn (yellow) even when latency is low
    expect(classifySampleSeverity({ p50: 8, p95: 10, lossPct: 10, warnMs: 25 })).toBe("warn");
    // Heavy loss (>= 50%) -> critical (red)
    expect(classifySampleSeverity({ p50: 8, p95: 10, lossPct: 50, warnMs: 25 })).toBe("critical");
    expect(worseSeverity("normal", "warn")).toBe("warn");
    expect(worseSeverity("warn", "critical")).toBe("critical");
  });

  it("resolves effective warnMs in priority order and bounds Y-scale expansion", () => {
    expect(
      resolveEffectiveWarnMs({
        cellWarnMs: 22,
        seriesWarnMs: 30,
        target: { latency_warn_ms: 40 },
      })
    ).toBe(22);

    expect(
      resolveEffectiveWarnMs({
        target: {
          latency_warn_ms: 40,
          probe_latency_overrides: { "p-1": 18 },
        },
        probeId: "p-1",
      })
    ).toBe(18);

    // Adaptive fallback from series P25: max(10 * 2, 10 + 15) = 25
    expect(
      resolveEffectiveWarnMs({
        series: { p25_ms: [10, 10, 12, 14], p50_ms: [12, 12, 14, 16] },
      })
    ).toBe(25);

    // Subtle Y headroom only when warnMs <= dataTop * 1.35
    expect(computeChartYUpper(20, 25)).toBeCloseTo(27, 2);
    // Fallback 500ms does not flatten a 10ms chart
    expect(computeChartYUpper(10, 500)).toBe(10);
  });
});
