import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TimeRangePicker } from "./TimeRangePicker";

afterEach(() => {
  cleanup();
});

describe("TimeRangePicker", () => {
  it("renders 5 quick pills + More trigger and keeps popover clean of technical resolution jargon", async () => {
    const user = userEvent.setup();
    const onSelectPreset = vi.fn();
    const onApplyCustom = vi.fn();

    render(
      <TimeRangePicker
        value="3h"
        testId="picker"
        onSelectPreset={onSelectPreset}
        onApplyCustom={onApplyCustom}
      />
    );

    // 5 quick pills visible directly on the bar
    for (const label of ["15m", "1h", "3h", "24h", "7d"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "3h" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );

    // Clicking quick pill fires onSelectPreset
    await user.click(screen.getByRole("button", { name: "24h" }));
    expect(onSelectPreset).toHaveBeenCalledWith("24h");

    // Open More popover
    await user.click(screen.getByTestId("picker-more-btn"));
    const popover = screen.getByTestId("picker-popover");
    expect(popover).toBeInTheDocument();

    // Clean UI: must NOT contain technical DB aggregation jargon
    expect(popover.textContent).not.toMatch(/Auto resolution|agg_1m|agg_5m|agg_1h|1h agg|raw/i);

    // Secondary presets 3d (3 days) & 30d (1 Month) are selectable
    expect(screen.getByTestId("picker-preset-3d")).toHaveTextContent("3 days");
    expect(screen.getByTestId("picker-preset-30d")).toHaveTextContent("1 Month");

    await user.click(screen.getByTestId("picker-preset-30d"));
    expect(onSelectPreset).toHaveBeenCalledWith("30d");
    expect(screen.queryByTestId("picker-popover")).not.toBeInTheDocument();
  });

  it("highlights secondary preset on trigger, validates custom date range, and supports Today / Yesterday quick picks", async () => {
    const user = userEvent.setup();
    const onSelectPreset = vi.fn();
    const onApplyCustom = vi.fn();

    const { rerender } = render(
      <TimeRangePicker
        value="3d"
        testId="picker"
        onSelectPreset={onSelectPreset}
        onApplyCustom={onApplyCustom}
      />
    );

    // Trigger reflects active secondary preset "3d"
    expect(screen.getByTestId("picker-more-btn")).toHaveTextContent("3d");

    // Open popover & test invalid reversed custom range
    await user.click(screen.getByTestId("picker-more-btn"));
    fireEvent.change(screen.getByTestId("picker-from-input"), {
      target: { value: "2026-11-19T14:00" },
    });
    fireEvent.change(screen.getByTestId("picker-to-input"), {
      target: { value: "2026-11-18T08:00" },
    });
    await user.click(screen.getByTestId("picker-apply-btn"));
    expect(screen.getByTestId("picker-error")).toHaveTextContent(
      "'From' must be earlier than 'To'."
    );
    expect(onApplyCustom).not.toHaveBeenCalled();

    // Valid custom range applies and closes popover
    fireEvent.change(screen.getByTestId("picker-from-input"), {
      target: { value: "2026-11-18T08:00" },
    });
    fireEvent.change(screen.getByTestId("picker-to-input"), {
      target: { value: "2026-11-19T14:00" },
    });
    await user.click(screen.getByTestId("picker-apply-btn"));
    expect(onApplyCustom).toHaveBeenCalledTimes(1);
    const applied = onApplyCustom.mock.calls[0][0];
    expect(applied.toSec - applied.fromSec).toBe(30 * 3600);
    expect(screen.queryByTestId("picker-popover")).not.toBeInTheDocument();

    // Re-render with active customWindow -> trigger displays formatted date range
    rerender(
      <TimeRangePicker
        value="3d"
        customWindow={applied}
        testId="picker"
        onSelectPreset={onSelectPreset}
        onApplyCustom={onApplyCustom}
      />
    );
    expect(screen.getByTestId("picker-more-btn")).toHaveTextContent(
      /18 Nov 08:00\s+–\s+19 Nov 14:00/
    );

    // Open popover & test Quick Yesterday
    await user.click(screen.getByTestId("picker-more-btn"));
    await user.click(screen.getByTestId("picker-quick-yesterday"));
    expect(onApplyCustom).toHaveBeenCalledTimes(2);
    const yesterday = onApplyCustom.mock.calls[1][0];
    expect(yesterday.toSec - yesterday.fromSec).toBe(86399);

    // Open popover & press Escape -> closes popover cleanly
    await user.click(screen.getByTestId("picker-more-btn"));
    expect(screen.getByTestId("picker-popover")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("picker-popover")).not.toBeInTheDocument();
  });

  it("renders subtle loading indicator when loading=true and fires onSelectPreset when re-clicking the active preset", async () => {
    const user = userEvent.setup();
    const onSelectPreset = vi.fn();
    const onApplyCustom = vi.fn();

    const { rerender } = render(
      <TimeRangePicker
        value="3h"
        loading
        testId="picker"
        onSelectPreset={onSelectPreset}
        onApplyCustom={onApplyCustom}
      />
    );

    expect(screen.getByTestId("picker")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByTestId("picker-loading")).toBeInTheDocument();

    // Re-clicking active "3h" pill still triggers onSelectPreset (enables zoom reset + series refresh)
    await user.click(screen.getByRole("button", { name: "3h" }));
    expect(onSelectPreset).toHaveBeenCalledWith("3h");

    rerender(
      <TimeRangePicker
        value="3h"
        loading={false}
        testId="picker"
        onSelectPreset={onSelectPreset}
        onApplyCustom={onApplyCustom}
      />
    );
    expect(screen.getByTestId("picker")).toHaveAttribute("aria-busy", "false");
    expect(screen.queryByTestId("picker-loading")).not.toBeInTheDocument();
  });
});
