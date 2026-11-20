import { describe, expect, it } from "vitest";
import {
  appendLiveTick,
  appendSparkPoint,
  classifySampleSeverity,
  computeChartXBounds,
  computeChartYUpper,
  computeWindowLossSummary,
  formatLoss,
  formatMs,
  getLossAxisSplits,
  rangeKeyToSeconds,
  resolveEffectiveWarnMs,
  resolveTargetBestPathSummary,
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

  it("resolves range tokens to seconds and computes full horizon X-axis bounds", () => {
    expect(rangeKeyToSeconds("15m")).toBe(900);
    expect(rangeKeyToSeconds("Live 5m")).toBe(300);
    expect(rangeKeyToSeconds("15m Live")).toBe(900);
    expect(rangeKeyToSeconds("3h")).toBe(10800);
    expect(rangeKeyToSeconds("3d")).toBe(3 * 86400);
    expect(rangeKeyToSeconds("7d")).toBe(604800);
    expect(rangeKeyToSeconds("30d")).toBe(30 * 86400);
    expect(rangeKeyToSeconds("custom")).toBeNull();

    // New target with only 4m of live samples on a 3h window still spans full 3h axis
    const now = 1_794_800_000;
    const partialLive = [now - 240, now - 120, now];
    expect(computeChartXBounds(partialLive, 10800, now)).toEqual([
      now - 10800,
      now,
    ]);
    expect(computeChartXBounds(partialLive, 900, now)).toEqual([
      now - 900,
      now,
    ]);
    // Explicit fixedBounds lock X-axis for custom historical windows
    expect(
      computeChartXBounds(partialLive, null, now, [now - 86400, now - 43200])
    ).toEqual([now - 86400, now - 43200]);
  });

  it("provides right-axis loss splits and computes zoomed window avg/peak loss", () => {
    expect(getLossAxisSplits(false)).toEqual([0, 25, 50, 75, 100]);
    expect(getLossAxisSplits(true)).toEqual([0, 50, 100]);

    const summary = computeWindowLossSummary(
      [100, 110, 120, 130, 140],
      [0, 20, 60, 0, 100],
      110,
      130
    );
    expect(summary).toEqual({
      sampleCount: 3,
      avgLossPct: (20 + 60 + 0) / 3,
      peakLossPct: 60,
    });

    const empty = computeWindowLossSummary([100, 110], [0, 10], 200, 300);
    expect(empty).toEqual({ sampleCount: 0, avgLossPct: 0, peakLossPct: 0 });
  });

  it("resolves target Best-Path summary for single-probe concrete fill and multi-probe Auto Best-Path", () => {
    const probes = [
      { id: "p-jkt", name: "Localhost", status: "online" as const },
      { id: "p-sgp", name: "Remote-SGP", status: "online" as const },
    ];
    const cells = [
      {
        target_id: "t1",
        probe_id: "p-jkt",
        p50_ms: 7.0,
        p95_ms: 14.0,
        baseline_ms: 6.5,
        warn_ms: 21.5,
        jitter_ms: 1.0,
        loss_pct: 0,
        sample_count: 30,
        status: "healthy" as const,
        sparkline: [],
      },
      {
        target_id: "t1",
        probe_id: "p-sgp",
        p50_ms: 29.0,
        p95_ms: 35.0,
        baseline_ms: 28.0,
        warn_ms: 56.0,
        jitter_ms: 2.0,
        loss_pct: 0,
        sample_count: 30,
        status: "healthy" as const,
        sparkline: [],
      },
    ];

    // Single probe -> concrete Best-Path ms auto-fill (~22 ms)
    const singleSummary = resolveTargetBestPathSummary(
      {
        id: "t1",
        assign_all_probes: false,
        probe_ids: ["p-jkt"],
        latency_warn_ms: 0,
        probe_latency_overrides: {},
        timeout_ms: 1000,
      },
      cells,
      probes
    );
    expect(singleSummary.primaryBaselineMs).toBe(6.5);
    expect(singleSummary.primaryAutoWarnMs).toBe(21.5);
    expect(singleSummary.concreteFillMs).toBe(22);
    expect(singleSummary.recommendedRuleThresholdMs).toBe(22);

    // Multi-probe with 0=Auto -> recommends 0 (Auto per path), while concreteFillMs gives max 56
    const multiSummary = resolveTargetBestPathSummary(
      {
        id: "t1",
        assign_all_probes: true,
        probe_ids: [],
        latency_warn_ms: 0,
        probe_latency_overrides: {},
        timeout_ms: 1000,
      },
      cells,
      probes
    );
    expect(multiSummary.recommendedRuleThresholdMs).toBe(0);
    expect(multiSummary.concreteFillMs).toBe(56);

    // Explicit manual Warn RTT overrides auto calculation
    const explicitSummary = resolveTargetBestPathSummary(
      {
        id: "t1",
        assign_all_probes: true,
        probe_ids: [],
        latency_warn_ms: 12,
        probe_latency_overrides: {},
        timeout_ms: 1000,
      },
      cells,
      probes
    );
    expect(explicitSummary.recommendedRuleThresholdMs).toBe(12);
    expect(explicitSummary.concreteFillMs).toBe(12);
  });
});
