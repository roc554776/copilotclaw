import { render, screen, waitFor, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatusPage } from "../pages/StatusPage";

// URL-map based MockEventSource so global SSE and other connections are independent
const mockEventSources = new Map<string, MockEventSource>();

class MockEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  readyState = 1;
  constructor(public url: string) {
    mockEventSources.set(url, this);
  }
  close() {
    this.readyState = 2;
    mockEventSources.delete(this.url);
  }
}

// Set early so it's available even before beforeEach runs
(globalThis as unknown as Record<string, unknown>).EventSource = MockEventSource;

/** Helper to get the global SSE source */
function getGlobalSse(): MockEventSource | undefined {
  return mockEventSources.get("/api/global-events");
}

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
    mockEventSources.clear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const urlStr = typeof url === "string" ? url : (url as Request).url;
      if (urlStr.includes("/api/status")) {
        return { ok: true, json: () => Promise.resolve(mockStatus) } as Response;
      }
      if (urlStr.includes("/api/system-prompts/original")) {
        return { ok: true, json: () => Promise.resolve([]) } as Response;
      }
      if (urlStr.includes("/api/token-usage")) {
        return { ok: true, json: () => Promise.resolve([]) } as Response;
      }
      if (urlStr.includes("/api/quota")) {
        return { ok: false, json: () => Promise.resolve({}) } as Response;
      }
      if (urlStr.includes("/api/models")) {
        return { ok: false, json: () => Promise.resolve({}) } as Response;
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

  it("updates tokenUsage5h when token_usage_update SSE event is received", async () => {
    render(
      <MemoryRouter>
        <StatusPage />
      </MemoryRouter>,
    );

    // Wait for initial render
    await waitFor(() => {
      expect(screen.getAllByText("running").length).toBeGreaterThanOrEqual(1);
    });

    // Simulate SSE connected
    const sseSource = getGlobalSse();
    expect(sseSource).toBeDefined();

    const summary = [
      {
        model: "claude-opus-4-5",
        inputTokens: 12345,
        outputTokens: 6789,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        multiplier: 1,
      },
    ];

    // Fire the token_usage_update event via SSE
    await act(async () => {
      sseSource!.onmessage?.({
        data: JSON.stringify({ type: "token_usage_update", summary }),
      });
    });

    // The tokenUsage5h table should now show the model
    await waitFor(() => {
      expect(screen.getAllByText("claude-opus-4-5").length).toBeGreaterThanOrEqual(1);
    });
    // And the token counts
    await waitFor(() => {
      expect(screen.getByText("12,345")).toBeDefined();
    });
  });

  it("does not call refreshPeriods on a polling interval (only once on mount)", async () => {
    let tokenUsageCallCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const urlStr = typeof url === "string" ? url : (url as Request).url;
      if (urlStr.includes("/api/token-usage")) {
        tokenUsageCallCount++;
        return { ok: true, json: () => Promise.resolve([]) } as Response;
      }
      if (urlStr.includes("/api/status")) {
        return { ok: true, json: () => Promise.resolve(mockStatus) } as Response;
      }
      if (urlStr.includes("/api/system-prompts/original")) {
        return { ok: true, json: () => Promise.resolve([]) } as Response;
      }
      if (urlStr.includes("/api/quota")) {
        return { ok: false, json: () => Promise.resolve({}) } as Response;
      }
      if (urlStr.includes("/api/models")) {
        return { ok: false, json: () => Promise.resolve({}) } as Response;
      }
      return { ok: false, json: () => Promise.resolve({}) } as Response;
    });

    render(
      <MemoryRouter>
        <StatusPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getAllByText("running").length).toBeGreaterThanOrEqual(1);
    });

    // Advance time by 2 minutes — if polling were active, it would have fired again
    await act(async () => {
      vi.advanceTimersByTime(120_000);
    });

    // There are 5 token-usage calls (1 from refresh() for 5h + 4 from refreshPeriods for each period)
    // plus 0 extra polling calls after the initial mount
    const callsAfterMount = tokenUsageCallCount;

    await act(async () => {
      vi.advanceTimersByTime(120_000);
    });

    // Call count should not increase after the initial mount calls
    expect(tokenUsageCallCount).toBe(callsAfterMount);
  });

  it("has data-global-sse-connected attribute on container", async () => {
    const { container } = render(
      <MemoryRouter>
        <StatusPage />
      </MemoryRouter>,
    );

    // Initially false (SSE not yet connected in mock)
    const div = container.firstChild as HTMLElement;
    expect(div.getAttribute("data-global-sse-connected")).toBe("false");
  });
});
