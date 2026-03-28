import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionsListPage } from "../pages/SessionsListPage";

const mockStatusResponse = {
  gateway: { status: "ok", version: "1.0.0" },
  agent: {
    sessions: {
      "abstract-id-alpha-1234": {
        status: "active",
        boundChannelId: "chan-abcdef12",
        startedAt: "2026-03-28T10:00:00Z",
        physicalSession: {
          sessionId: "phys-current-aaa",
          model: "gpt-4o",
          currentState: "idle",
          startedAt: "2026-03-28T10:00:00Z",
        },
        physicalSessionHistory: [
          {
            sessionId: "phys-history-bbb",
            model: "gpt-4o-mini",
            currentState: "ended",
            startedAt: "2026-03-28T09:00:00Z",
          },
        ],
      },
      "abstract-id-beta-5678": {
        status: "idle",
        startedAt: "2026-03-28T08:00:00Z",
        physicalSessionHistory: [],
      },
    },
  },
  agentCompatibility: "ok",
  config: {},
};

// Physical session IDs known to the abstract sessions
const knownPhysicalIds = ["phys-current-aaa", "phys-history-bbb"];
// An orphaned physical session
const orphanedId = "orphan-session-zzz";

function renderPage(path = "/sessions") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/sessions" element={<SessionsListPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("SessionsListPage", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/api/status")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockStatusResponse),
        } as Response);
      }
      if (url.includes("/api/session-events/sessions")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([...knownPhysicalIds, orphanedId]),
        } as Response);
      }
      // For orphaned session event enrichment
      if (url.includes(`/api/sessions/${orphanedId}/events`)) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              { type: "session.start", timestamp: "2026-03-28T07:00:00Z", data: {} },
              { type: "assistant.usage", timestamp: "2026-03-28T07:01:00Z", data: { model: "claude-3" } },
            ]),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([]),
      } as Response);
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows abstract sessions", async () => {
    renderPage();

    await waitFor(() => {
      // Both abstract session IDs are sliced to 8 chars: "abstract"
      const items = screen.getAllByText("abstract");
      expect(items.length).toBe(2);
    });

    // Status shown
    expect(screen.getAllByText("active").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("idle").length).toBeGreaterThanOrEqual(1);
  });

  it("shows physical sessions as children of abstract sessions", async () => {
    renderPage();

    await waitFor(() => {
      // Current physical session (sliced to 12 chars: "phys-current")
      expect(screen.getAllByText("phys-current").length).toBeGreaterThanOrEqual(1);
    });

    // History physical session (sliced to 12 chars: "phys-history")
    expect(screen.getAllByText("phys-history").length).toBeGreaterThanOrEqual(1);

    // Labels
    expect(screen.getAllByText("current").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("history").length).toBeGreaterThanOrEqual(1);
  });

  it("shows orphaned physical sessions", async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getAllByText("Other physical sessions").length).toBeGreaterThanOrEqual(1);
    });

    // orphan-session-zzz sliced to 12 chars: "orphan-sessi"
    expect(screen.getAllByText("orphan-sessi").length).toBeGreaterThanOrEqual(1);
  });

  it("highlights focused abstract session", async () => {
    renderPage("/sessions?focus=abstract-id-alpha-1234");

    await waitFor(() => {
      const cards = screen.getAllByTestId("abstract-session-abstract-id-alpha-1234");
      expect(cards.length).toBeGreaterThanOrEqual(1);
      // border is set as shorthand "2px solid #58a6ff" — jsdom normalizes to rgb
      expect(cards[0]!.style.border).toContain("rgb(88, 166, 255)");
    });
  });

  it("has title Sessions", async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getAllByText("Sessions").length).toBeGreaterThanOrEqual(1);
    });
  });
});
