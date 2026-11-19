import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import LoginPage from "./page";

const replaceMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
}));

describe("LoginPage", () => {
  afterEach(() => {
    cleanup();
    replaceMock.mockReset();
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/login");
  });

  it("shows validation error when password is missing", async () => {
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.click(screen.getByRole("button", { name: /sign in to noc/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /username and password are required/i
    );
  });

  it("redirects to safe relative ?next= zoom target after successful login", async () => {
    window.history.replaceState(null, "", "/login?next=%2F%3Fzoom%3Dt-1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ username: "admin" }), { status: 200 }))
    );

    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(screen.getByLabelText(/password/i), "secret123");
    await user.click(screen.getByRole("button", { name: /sign in to noc/i }));

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith("/?zoom=t-1");
    });
  });
});
