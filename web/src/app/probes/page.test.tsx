import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ProbesPage from "./page";
import type { Probe } from "@/lib/api";

const mockRouter = { replace: vi.fn(), push: vi.fn() };

vi.mock("next/navigation", () => ({
  useRouter: () => mockRouter,
  usePathname: () => "/probes",
}));

function makeProbe(overrides: Partial<Probe>): Probe {
  return {
    id: "00000000-0000-7000-8000-000000000001",
    name: "Local Central Probe",
    location_label: "Central Host",
    isp_asn: "LOCAL",
    is_local: true,
    status: "online",
    pending_backlog_count: 0,
    clock_offset_ms: 0.2,
    last_seen_at: "2026-11-15T12:00:00Z",
    agent_version: "1.0.0",
    created_at: "2026-11-15T00:00:00Z",
    ...overrides,
  };
}

describe("ProbesPage", () => {
  let probeState: Probe[];

  beforeEach(() => {
    probeState = [
      makeProbe({}),
      makeProbe({
        id: "00000000-0000-7000-8000-000000000002",
        name: "Remote-SGP",
        location_label: "Singapore Equinix",
        isp_asn: "AS13335",
        is_local: false,
      }),
    ];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";

      if (url === "/api/probes" && method === "GET") {
        return new Response(JSON.stringify(probeState), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.startsWith("/api/probes/") && method === "PUT") {
        const id = url.split("/").pop() ?? "";
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          name: string;
          location_label: string;
          isp_asn: string;
        };
        const idx = probeState.findIndex((p) => p.id === id);
        if (idx === -1) {
          return new Response(JSON.stringify({ detail: "not found" }), { status: 404 });
        }
        probeState[idx] = {
          ...probeState[idx],
          name: body.name,
          location_label: body.location_label,
          isp_asn: body.isp_asn,
        };
        return new Response(JSON.stringify(probeState[idx]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("unexpected request", { status: 500 });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("allows editing both local and remote probe names, location, and ISP/ASN", async () => {
    const user = userEvent.setup();
    render(<ProbesPage />);

    expect(await screen.findByText("Local Central Probe")).toBeInTheDocument();
    expect(screen.getByText("Remote-SGP")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Edit probe Local Central Probe" }));

    const modalTitle = screen.getByRole("heading", { name: "Edit Probe" });
    expect(modalTitle).toBeInTheDocument();

    const nameInput = screen.getByLabelText("Probe Name *");
    const locInput = screen.getByLabelText("Location Label");
    const asnInput = screen.getByLabelText("ISP / ASN");

    // Validation check blocks too-short names client-side
    await user.clear(nameInput);
    await user.type(nameInput, "X");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/2 to 80 characters/i);

    await user.clear(nameInput);
    await user.type(nameInput, "  NOC-Jakarta-Core  ");
    await user.clear(locInput);
    await user.type(locInput, "Jakarta Cyber1");
    await user.clear(asnInput);
    await user.type(asnInput, "AS7713");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(await screen.findByText("NOC-Jakarta-Core")).toBeInTheDocument();
    expect(screen.getByText(/Jakarta Cyber1 · AS7713/)).toBeInTheDocument();
  });
});
