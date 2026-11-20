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

  it("renders clean Smoker branding, empty inputs with placeholders, and shows validation error when missing", async () => {
    const user = userEvent.setup();
    render(<LoginPage />);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/^Smoker$/);
    expect(screen.getByText("Latency Monitoring")).toBeInTheDocument();
    expect(screen.queryByText(/NOC/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Operator/i)).not.toBeInTheDocument();

    const usernameInput = screen.getByLabelText(/^username$/i);
    const passwordInput = screen.getByLabelText(/^password$/i);
    expect(usernameInput).toHaveValue("");
    expect(usernameInput).toHaveAttribute("placeholder", "Enter username");
    expect(passwordInput).toHaveValue("");
    expect(passwordInput).toHaveAttribute("placeholder", "Enter password");

    await user.click(screen.getByRole("button", { name: /^sign in$/i }));
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

    await user.type(screen.getByLabelText(/^username$/i), "admin");
    await user.type(screen.getByLabelText(/^password$/i), "secret123");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith("/?zoom=t-1");
    });
  });
});
