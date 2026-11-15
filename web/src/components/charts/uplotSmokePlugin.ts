import type uPlot from "uplot";
import { drawSmokeScene } from "@/lib/smoke-canvas";
import type { ProbeSeriesInput } from "@/lib/smoke-math";

export interface SmokeBandsRef {
  current: ProbeSeriesInput;
}

export interface SmokeWarnRef {
  current: number | null;
}

/**
 * Custom uPlot plugin rendering SmokePing-style layered quantile clouds,
 * vertical packet loss indicators, a dashed WARN threshold reference line,
 * and a segmented median P50 trace colored green (#10B981) when normal,
 * yellow (#FBBF24) when touching/crossing threshold or experiencing intermittent loss,
 * and red (#F43F5E) at >= 50% packet loss.
 */
export function createSmokePlugin(
  seriesRef: SmokeBandsRef,
  warnMsRef?: SmokeWarnRef
): uPlot.Plugin {
  return {
    hooks: {
      draw: [
        (u: uPlot) => {
          const s = seriesRef.current;
          if (!s.timestamps || s.timestamps.length === 0) return;

          drawSmokeScene({
            ctx: u.ctx,
            series: s,
            box: u.bbox,
            toX: (ts) => u.valToPos(ts, "x", true),
            toY: (val) => u.valToPos(val, "y", true),
            yMax: u.scales.y?.max,
            warnMs: warnMsRef?.current ?? s.warn_ms ?? null,
          });
        },
      ],
    },
  };
}
