import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { MiniSparkline } from "./MiniSparkline";
import { TRACE_COLORS } from "@/lib/smoke-math";

describe("MiniSparkline", () => {
  it("colors normal segments green and threshold-breaching / intermittent segments yellow", () => {
    const { container, getByTestId } = render(
      <MiniSparkline
        status="healthy"
        warnMs={20}
        points={[
          { ts: 1, min: 6, p50: 8, p95: 10, loss: 0 },
          { ts: 2, min: 7, p50: 9, p95: 11, loss: 0 },
          { ts: 3, min: 18, p50: 28, p95: 34, loss: 0 },
          { ts: 4, min: 8, p50: 10, p95: 12, loss: 15 },
          { ts: 5, min: 9, p50: 11, p95: 14, loss: 60 },
        ]}
      />
    );

    expect(getByTestId("sparkline-warn-line")).toBeInTheDocument();
    const paths = Array.from(container.querySelectorAll("path"));
    const strokes = paths.map((p) => p.getAttribute("stroke"));
    expect(strokes).toContain(TRACE_COLORS.normal.stroke);
    expect(strokes).toContain(TRACE_COLORS.warn.stroke);
    expect(strokes).toContain(TRACE_COLORS.critical.stroke);
  });
});
