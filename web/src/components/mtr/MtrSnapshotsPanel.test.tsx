import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MtrSnapshotsPanel } from "./MtrSnapshotsPanel";

describe("MtrSnapshotsPanel", () => {
  it("displays rDNS hostname, error alerts, and allows per-probe MTR dispatch", async () => {
    const user = userEvent.setup();
    const onRunNow = vi.fn();

    render(
      <MtrSnapshotsPanel
        probes={[
          { id: "p1", name: "probe-sgp" },
          { id: "p2", name: "probe-jkt" },
        ]}
        running={false}
        errorMessage="probe-sgp: dns resolution failed"
        onRunNow={onRunNow}
        snapshots={[
          {
            id: "snap-1",
            probe_id: "p1",
            probe_name: "probe-sgp",
            target_id: "t1",
            captured_at: "2026-11-15T10:00:00Z",
            trigger_reason: "auto_loss",
            hops: [
              {
                hop: 1,
                ip: "1.1.1.1",
                host: "one.one.one.one",
                sent: 5,
                recv: 5,
                loss_pct: 0,
                best_us: 4000,
                avg_us: 4500,
                worst_us: 5000,
                stdev_us: 300,
              },
            ],
          },
          {
            id: "snap-2",
            probe_id: "p2",
            probe_name: "probe-jkt",
            target_id: "t1",
            captured_at: "2026-11-15T10:05:00Z",
            trigger_reason: "auto_latency",
            hops: [],
          },
        ]}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      /probe-sgp: dns resolution failed/i
    );
    expect(screen.getByText("1.1.1.1")).toBeInTheDocument();
    expect(screen.getByText("(one.one.one.one)")).toBeInTheDocument();
    expect(screen.getByText("AUTO LOSS")).toBeInTheDocument();
    expect(screen.getByText("AUTO HIGH RTT")).toBeInTheDocument();

    const select = screen.getByLabelText(/select probe for manual mtr/i);
    await user.selectOptions(select, "p2");
    await user.click(screen.getByRole("button", { name: /run mtr now/i }));

    expect(onRunNow).toHaveBeenCalledWith("p2");
  });
});
