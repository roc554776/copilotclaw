import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatusPage } from "../pages/StatusPage";

const mockStatus = {
  gateway: { status: "running", version: "0.30.0", profile: "default" },
  agent: {
    version: "1.2.0",
    startedAt: "2026-03-28T09:00:00Z",
    sessions: {
      "sess-001": {
        status: "idle",
        boundChannelId: "ch-abc",
        startedAt: "2026-03-28T09:00:00Z",
        physicalSession: {
          sessionId: "phys-123456789012",
          model: "gpt-4o",
          currentState: "idle",
          startedAt: "2026-03-28T09:00:00Z",
        },
      },
    },
  },
  agentCompatibility: "compatible",
  config: { model: "gpt-4o", zeroPremium: false },
};

describe("StatusPage", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const urlStr = typeof url === "string" ? url : (url as Request).url;
      if (urlStr.includes("/api/status")) {
        return { ok: true, json: () => Promise.resolve(mockStatus) } as Response;
      }
      if (urlStr.includes("/api/system-prompts/original")) {
        return { ok: true, json: () => Promise.resolve([]) } as Response;
      }
      return { ok: false, json: () => Promise.resolve({}) } as Response;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders gateway status", async () => {
    render(
      <MemoryRouter>
        <StatusPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getAllByText("running").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("renders gateway version", async () => {
    render(
      <MemoryRouter>
        <StatusPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getAllByText("0.30.0").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("renders agent version", async () => {
    render(
      <MemoryRouter>
        <StatusPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getAllByText("1.2.0").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("renders session model", async () => {
    render(
      <MemoryRouter>
        <StatusPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getAllByText("gpt-4o").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("has a link back to chat dashboard", async () => {
    render(
      <MemoryRouter>
        <StatusPage />
      </MemoryRouter>,
    );

    const links = screen.getAllByRole("link");
    const backLink = links.find((l) => l.getAttribute("href") === "/");
    expect(backLink).toBeDefined();
  });

  it("shows 'All sessions' link to /sessions (not 'All physical sessions')", async () => {
    render(
      <MemoryRouter>
        <StatusPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      const links = screen.getAllByRole("link");
      const sessionsLink = links.find((l) => l.getAttribute("href") === "/sessions");
      expect(sessionsLink).toBeDefined();
      expect(sessionsLink!.textContent).toContain("All sessions");
      expect(sessionsLink!.textContent).not.toContain("physical");
    });
  });
});
