import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionEventsPage } from "../pages/SessionEventsPage";

// Mock EventSource — URL-map based, same pattern as DashboardPage.test.tsx
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

(globalThis as unknown as Record<string, unknown>).EventSource = MockEventSource;

/** Helper to get the session SSE source for a given sessionId */
function getSessionSse(sessionId: string): MockEventSource | undefined {
  return mockEventSources.get(`/api/sessions/${encodeURIComponent(sessionId)}/events/stream`);
}

const mockEvents = [
  {
    id: 1,
    type: "session.start",
    timestamp: "2026-03-28T10:00:00Z",
    data: { sessionId: "sess-abc" },
  },
  {
    id: 2,
    type: "assistant.usage",
    timestamp: "2026-03-28T10:01:00Z",
    data: { model: "gpt-4o", tokens: 100 },
  },
  {
    id: 3,
    type: "tool.execution",
    timestamp: "2026-03-28T10:02:00Z",
    data: { toolName: "read_file" },
    parentId: "parent-1234567890",
  },
];

const mockStatusResponse = {
  gateway: { status: "ok", version: "1.0.0" },
  agent: {
    sessions: {
      "abstract-session-1": {
        status: "active",
        physicalSession: { sessionId: "test-session-id", model: "gpt-4o", currentState: "idle", startedAt: "2026-03-28T10:00:00Z" },
        physicalSessionHistory: [],
      },
    },
  },
  agentCompatibility: "ok",
  config: {},
};

function renderPage(sessionId = "test-session-id") {
  return render(
    <MemoryRouter initialEntries={[`/sessions/${sessionId}/events`]}>
      <Routes>
        <Route path="/sessions/:sessionId/events" element={<SessionEventsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("SessionEventsPage", () => {
  beforeEach(() => {
    cleanup();
    mockEventSources.clear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/api/status")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockStatusResponse),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(mockEvents),
      } as Response);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders events after fetch", async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getAllByText("session.start").length).toBeGreaterThanOrEqual(1);
    });

    expect(screen.getAllByText("assistant.usage").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("tool.execution").length).toBeGreaterThanOrEqual(1);
  });

  it("shows event count", async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getAllByText("(3 events loaded)").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("shows parent ID for events that have one", async () => {
    renderPage();

    await waitFor(() => {
      // parentId "parent-1234567890" is sliced to first 8 chars: "parent-1"
      expect(screen.getAllByText("[parent: parent-1]").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("does not have a refresh button", async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getAllByText("session.start").length).toBeGreaterThanOrEqual(1);
    });

    const refreshBtns = screen.queryAllByRole("button", { name: /refresh/i });
    expect(refreshBtns).toHaveLength(0);
  });

  it("renders Back to Sessions link", async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getAllByText("session.start").length).toBeGreaterThanOrEqual(1);
    });

    const backLinks = screen.getAllByText(/Back to Sessions/);
    expect(backLinks.length).toBeGreaterThanOrEqual(1);
    expect(backLinks[0]!.tagName).toBe("A");
  });

  it("Back to Sessions link includes focus param when abstract session found", async () => {
    renderPage();

    await waitFor(() => {
      const backLinks = screen.getAllByText(/Back to Sessions/);
      expect(backLinks[0]!.getAttribute("href")).toBe("/sessions?focus=abstract-session-1");
    });
  });

  it("Back to Sessions link has no focus param when abstract session not found", async () => {
    // This test needs isolated mocks — the status endpoint returns empty sessions
    cleanup();
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url === "/api/status" || url.startsWith("/api/status?")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            gateway: { status: "ok", version: "1.0.0" },
            agent: { sessions: {} },
            agentCompatibility: "ok",
            config: {},
          }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(mockEvents),
      } as Response);
    });

    render(
      <MemoryRouter initialEntries={["/sessions/unknown-xyz/events"]}>
        <Routes>
          <Route path="/sessions/:sessionId/events" element={<SessionEventsPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      const backLinks = screen.getAllByText(/Back to Sessions/);
      expect(backLinks[0]!.getAttribute("href")).toBe("/sessions");
    });
  });

  it("subscribes to SSE stream on mount", async () => {
    renderPage("test-session-id");

    await waitFor(() => {
      expect(getSessionSse("test-session-id")).not.toBeUndefined();
    });
  });

  it("appends event to state when session_event_appended SSE message arrives", async () => {
    renderPage("test-session-id");

    await waitFor(() => {
      expect(screen.getAllByText("session.start").length).toBeGreaterThanOrEqual(1);
    });

    const src = getSessionSse("test-session-id");
    expect(src).not.toBeUndefined();

    // Dispatch a new event via SSE
    src!.onmessage?.({
      data: JSON.stringify({
        type: "session_event_appended",
        event: {
          id: 99,
          type: "tool.execution_complete",
          timestamp: "2026-04-14T10:03:00Z",
          data: { result: "ok" },
        },
      }),
    });

    await waitFor(() => {
      expect(screen.getAllByText("tool.execution_complete").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("deduplicates events with same id received via SSE", async () => {
    renderPage("test-session-id");

    await waitFor(() => {
      expect(screen.getAllByText("session.start").length).toBeGreaterThanOrEqual(1);
    });

    const src = getSessionSse("test-session-id");
    expect(src).not.toBeUndefined();

    const newEvent = {
      type: "session_event_appended",
      event: {
        id: 1, // same id as existing mockEvents[0]
        type: "session.start",
        timestamp: "2026-03-28T10:00:00Z",
        data: { sessionId: "sess-abc" },
      },
    };

    // Dispatch the same event twice
    src!.onmessage?.({ data: JSON.stringify(newEvent) });
    src!.onmessage?.({ data: JSON.stringify(newEvent) });

    // Wait briefly
    await new Promise((r) => { setTimeout(r, 50); });

    // Count should remain 3 (no duplicates added)
    await waitFor(() => {
      expect(screen.getAllByText("(3 events loaded)").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("does not poll for new events (no additional fetch calls after initial load)", async () => {
    renderPage();

    await waitFor(() => {
      expect(fetch).toHaveBeenCalled();
    });

    const initialCount = vi.mocked(fetch).mock.calls.length;

    // Advance timer well past old 2s polling interval — no new fetches should occur
    vi.advanceTimersByTime(6000);

    // Fetch call count should remain unchanged (no polling)
    expect(vi.mocked(fetch).mock.calls.length).toBe(initialCount);
  });

  it("initial snapshot fetch is preserved", async () => {
    renderPage("test-session-id");

    await waitFor(() => {
      const calls = vi.mocked(fetch).mock.calls;
      const eventFetches = calls.filter((c) => {
        const url = typeof c[0] === "string" ? c[0] : (c[0] as Request).url;
        return url.includes("/api/sessions/test-session-id/events");
      });
      expect(eventFetches.length).toBeGreaterThanOrEqual(1);
    });
  });
});
