import { describe, expect, it, vi } from "vitest";
import { drawSmokeScene } from "./smoke-canvas";
import { TRACE_COLORS, type ProbeSeriesInput } from "./smoke-math";

function createMockCtx() {
  const strokes: string[] = [];
  const fills: string[] = [];
  const lineDashes: number[][] = [];
  const texts: string[] = [];

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
    fillRect: vi.fn(() => {
      fills.push(String(ctx.fillStyle));
    }),
    fill: vi.fn(() => {
      fills.push(String(ctx.fillStyle));
    }),
    stroke: vi.fn(() => {
      strokes.push(String(ctx.strokeStyle));
    }),
    setLineDash: vi.fn((dash: number[]) => {
      lineDashes.push(dash);
    }),
    fillText: vi.fn((text: string) => {
      texts.push(text);
    }),
  } as unknown as CanvasRenderingContext2D;

  return { ctx, strokes, fills, lineDashes, texts };
}

describe("drawSmokeScene", () => {
  it("draws normal (#10B981), threshold/intermittent warn (#FBBF24), and critical (#F43F5E) trace segments plus dashed WARN line", () => {
    const { ctx, strokes, lineDashes, texts } = createMockCtx();
    const series: ProbeSeriesInput = {
      probe_id: "p1",
      probe_name: "Local",
      location_label: "DC1",
      timestamps: [100, 110, 120, 130, 140],
      min_ms: [6, 7, 18, 9, 10],
      p25_ms: [7, 8, 22, 10, 11],
      p50_ms: [8, 10, 32, 11, 12],
      p75_ms: [9, 12, 38, 13, 14],
      p95_ms: [11, 14, 44, 15, 18],
      max_ms: [12, 15, 48, 16, 20],
      jitter_ms: [1, 1, 5, 2, 3],
      // ts 120 breaches warnMs=20 (32ms); ts 130 has intermittent loss 10%; ts 140 has heavy loss 60%
      loss_pct: [0, 0, 0, 10, 60],
    };

    drawSmokeScene({
      ctx,
      series,
      box: { left: 20, top: 10, width: 400, height: 160 },
      toX: (ts) => 20 + ((ts - 100) / 40) * 400,
      toY: (val) => 170 - (val / 50) * 160,
      yMax: 50,
      warnMs: 20,
    });

    expect(strokes).toContain(TRACE_COLORS.normal.stroke);
    expect(strokes).toContain(TRACE_COLORS.warn.stroke);
    expect(strokes).toContain(TRACE_COLORS.critical.stroke);
    expect(lineDashes).toContainEqual([4, 4]);
    expect(texts).toContain("WARN 20.0 ms");
  });

  it("draws packet loss bars with heights linearly calibrated 1:1 to 0%..100%", () => {
    const { ctx } = createMockCtx();
    const series: ProbeSeriesInput = {
      probe_id: "p1",
      probe_name: "Local",
      location_label: "DC1",
      timestamps: [100, 110, 120, 130],
      min_ms: [5, 5, 5, null],
      p25_ms: [6, 6, 6, null],
      p50_ms: [7, 7, 7, null],
      p75_ms: [8, 8, 8, null],
      p95_ms: [9, 9, 9, null],
      max_ms: [10, 10, 10, null],
      jitter_ms: [1, 1, 1, null],
      loss_pct: [0, 25, 50, 100],
    };

    drawSmokeScene({
      ctx,
      series,
      box: { left: 20, top: 10, width: 400, height: 200 },
      toX: (ts) => 20 + ((ts - 100) / 30) * 400,
      toY: (val) => 210 - (val / 50) * 200,
      yMax: 50,
    });

    const fillRectCalls = (ctx.fillRect as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(fillRectCalls).toHaveLength(3);
    // 25% of height=200 => y=160, h=50
    expect(fillRectCalls[0][1]).toBeCloseTo(160, 4);
    expect(fillRectCalls[0][3]).toBeCloseTo(50, 4);
    // 50% of height=200 => y=110, h=100
    expect(fillRectCalls[1][1]).toBeCloseTo(110, 4);
    expect(fillRectCalls[1][3]).toBeCloseTo(100, 4);
    // 100% of height=200 => y=10, h=200
    expect(fillRectCalls[2][1]).toBeCloseTo(10, 4);
    expect(fillRectCalls[2][3]).toBeCloseTo(200, 4);
  });
});
