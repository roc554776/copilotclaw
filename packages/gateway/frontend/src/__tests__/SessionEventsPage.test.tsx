import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionEventsPage } from "../pages/SessionEventsPage";

const mockEvents = [
  {
    type: "session.start",
    timestamp: "2026-03-28T10:00:00Z",
    data: { sessionId: "sess-abc" },
  },
  {
    type: "assistant.usage",
    timestamp: "2026-03-28T10:01:00Z",
    data: { model: "gpt-4o", tokens: 100 },
  },
  {
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
      expect(screen.getAllByText("(3 events)").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("shows parent ID for events that have one", async () => {
    renderPage();

    await waitFor(() => {
      // parentId "parent-1234567890" is sliced to first 8 chars: "parent-1"
      expect(screen.getAllByText("[parent: parent-1]").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("has a refresh button", async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getAllByText("session.start").length).toBeGreaterThanOrEqual(1);
    });

    const refreshBtns = screen.getAllByRole("button", { name: /refresh/i });
    expect(refreshBtns.length).toBeGreaterThanOrEqual(1);
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

  it("polls for new events", async () => {
    renderPage();

    await waitFor(() => {
      expect(fetch).toHaveBeenCalled();
    });

    const initialCount = vi.mocked(fetch).mock.calls.length;

    // Advance timer by 2 seconds for next poll
    vi.advanceTimersByTime(2000);

    await waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(initialCount);
    });
  });
});
