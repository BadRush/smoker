import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SettingsPage from "./page";

const mockRouter = { replace: vi.fn(), push: vi.fn() };

vi.mock("next/navigation", () => ({
  useRouter: () => mockRouter,
  usePathname: () => "/settings",
}));

describe("SettingsPage screenshot watermark & shortcuts modal", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    window.localStorage.clear();
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/settings") {
        return new Response(
          JSON.stringify({
            raw_retention_days: 14,
            agg_retention_days: 730,
            default_quorum_min: 2,
            brand_name: "",
            alerting_enabled: true,
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows clean Smoker by anamBadrus placeholder (no Varnion example) and updates live PNG watermark preview", async () => {
    const user = userEvent.setup();
    render(<SettingsPage />);

    const input = await screen.findByLabelText(
      /Screenshot Watermark \/ Organization Name/i
    );
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/settings",
        expect.anything()
      );
    });
    expect(input).toHaveAttribute("placeholder", "Smoker by anamBadrus");
    expect(input.getAttribute("placeholder")).not.toMatch(/varnion/i);

    const preview = screen.getByTestId("watermark-live-preview");
    const previewText = screen.getByTestId("watermark-live-preview-text");
    expect(previewText).toHaveTextContent("Smoker by anamBadrus");
    expect(preview).toHaveTextContent("Default");

    await user.type(input, "NOC Core Team");
    expect(previewText).toHaveTextContent("NOC Core Team");
    expect(preview).toHaveTextContent("Custom");

    await user.clear(input);
    expect(previewText).toHaveTextContent("Smoker by anamBadrus");
    expect(preview).toHaveTextContent("Default");
  });

  it("opens Keyboard Shortcuts cheatsheet from NocShell button or '?' key and closes with Esc", async () => {
    const user = userEvent.setup();
    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByTestId("noc-shortcuts-btn")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("noc-shortcuts-btn"));
    expect(
      await screen.findByTestId("keyboard-shortcuts-modal")
    ).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(
      screen.queryByTestId("keyboard-shortcuts-modal")
    ).not.toBeInTheDocument();

    await user.keyboard("?");
    expect(
      await screen.findByTestId("keyboard-shortcuts-modal")
    ).toBeInTheDocument();
  });
});
