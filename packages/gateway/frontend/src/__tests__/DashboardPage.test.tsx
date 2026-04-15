import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardPage } from "../pages/DashboardPage";

const mockChannels = [
  { id: "ch-001-full-uuid", createdAt: "2026-03-28T09:00:00Z" },
  { id: "ch-002-full-uuid", createdAt: "2026-03-28T09:01:00Z" },
];

const mockMessages = [
  {
    id: "msg-2",
    channelId: "ch-001-full-uuid",
    sender: "agent",
    message: "Hello human",
    createdAt: "2026-03-28T10:01:00Z",
  },
  {
    id: "msg-1",
    channelId: "ch-001-full-uuid",
    sender: "user",
    message: "Hello agent",
    createdAt: "2026-03-28T10:00:00Z",
  },
];

const mockStatus = {
  gateway: { status: "running", version: "0.30.0" },
  agent: {
    version: "1.2.0",
    sessions: {
      "sess-001": {
        status: "idle",
        boundChannelId: "ch-001-full-uuid",
      },
    },
  },
  agentCompatibility: "compatible",
  config: {},
};

// Mock EventSource — URL-map based so channel SSE and global SSE are independent
const mockEventSources = new Map<string, MockEventSource>();

class MockEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  readyState = 1;
  constructor(public url: string) {
    // Track by URL so tests can dispatch events to the correct source
    mockEventSources.set(url, this);
  }
  close() {
    this.readyState = 2;
    mockEventSources.delete(this.url);
  }
}

// Set early so it's available even before beforeEach runs
(globalThis as unknown as Record<string, unknown>).EventSource = MockEventSource;

/** Helper to get the channel SSE source (URL contains /api/events?channel=) */
function getChannelSse(): MockEventSource | undefined {
  for (const [url, src] of mockEventSources) {
    if (url.startsWith("/api/events?channel=")) return src;
  }
  return undefined;
}

/** Helper to get the global SSE source */
function getGlobalSse(): MockEventSource | undefined {
  return mockEventSources.get("/api/global-events");
}

describe("DashboardPage", () => {
  beforeEach(() => {
    cleanup();
    mockEventSources.clear();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const urlStr = typeof url === "string" ? url : (url as Request).url;
      if (urlStr.includes("/api/channels") && !urlStr.includes("/messages")) {
        return { ok: true, json: () => Promise.resolve(mockChannels) } as Response;
      }
      if (urlStr.includes("/messages")) {
        return { ok: true, json: () => Promise.resolve(mockMessages) } as Response;
      }
      if (urlStr.includes("/api/status")) {
        return { ok: true, json: () => Promise.resolve(mockStatus) } as Response;
      }
      if (urlStr.includes("/api/logs")) {
        return { ok: true, json: () => Promise.resolve([]) } as Response;
      }
      if (urlStr.includes("/api/quota")) {
        return { ok: false, json: () => Promise.resolve({}) } as Response;
      }
      if (urlStr.includes("/api/models")) {
        return { ok: false, json: () => Promise.resolve({}) } as Response;
      }
      if (urlStr.includes("/draft")) {
        return { ok: true, json: () => Promise.resolve({ status: "saved" }) } as Response;
      }
      return { ok: false, json: () => Promise.resolve({}) } as Response;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders chat messages", async () => {
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getAllByText("Hello agent").length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.getAllByText("Hello human").length).toBeGreaterThanOrEqual(1);
  });

  it("renders channel tabs", async () => {
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getAllByText("ch-001-f").length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.getAllByText("ch-002-f").length).toBeGreaterThanOrEqual(1);
  });

  it("renders new channel button", async () => {
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getAllByText("+").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("renders send button", () => {
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );

    expect(screen.getAllByText("Send").length).toBeGreaterThanOrEqual(1);
  });

  it("sends a message on Alt+Enter", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const fetchMock = vi.mocked(fetch);

    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getAllByText("Hello agent").length).toBeGreaterThanOrEqual(1);
    });

    const textareas = screen.getAllByPlaceholderText(/Type a message/);
    const textarea = textareas[0]!;
    await user.type(textarea, "Test message");
    await user.keyboard("{Alt>}{Enter}{/Alt}");

    await waitFor(() => {
      const postCalls = fetchMock.mock.calls.filter((c) => {
        const init = c[1] as RequestInit | undefined;
        return init?.method === "POST";
      });
      expect(postCalls.length).toBeGreaterThan(0);
    });
  });

  it("does not send empty message", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const fetchMock = vi.mocked(fetch);

    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getAllByText("Hello agent").length).toBeGreaterThanOrEqual(1);
    });

    const callCountBefore = fetchMock.mock.calls.length;

    const textareas = screen.getAllByPlaceholderText(/Type a message/);
    const textarea = textareas[0]!;
    await user.type(textarea, "{Enter}");

    // No new POST call should have been made for the empty message
    const postCallsAfter = fetchMock.mock.calls
      .slice(callCountBefore)
      .filter((c) => {
        const init = c[1] as RequestInit | undefined;
        return init?.method === "POST";
      });
    expect(postCallsAfter.length).toBe(0);
  });

  it("flushes pending draft save when switching channels", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const fetchMock = vi.mocked(fetch);

    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );

    // Wait for channels to render
    await waitFor(() => {
      expect(screen.getAllByText("ch-001-f").length).toBeGreaterThanOrEqual(1);
    });

    // Type some text to trigger a draft save timer
    const textareas = screen.getAllByPlaceholderText(/Type a message/);
    const textarea = textareas[0]!;
    await user.type(textarea, "draft text");

    // Clear the text (simulating user deleting all input)
    await user.clear(textarea);

    // Switch channels before the 1-second debounce fires
    const tab2 = screen.getAllByText("ch-002-f")[0]!;
    await user.click(tab2);

    // The flush should have sent a PUT with null draft for the previous channel
    const draftPuts = fetchMock.mock.calls.filter((c) => {
      const urlStr = typeof c[0] === "string" ? c[0] : (c[0] as Request).url;
      const init = c[1] as RequestInit | undefined;
      return urlStr.includes("/draft") && init?.method === "PUT";
    });
    expect(draftPuts.length).toBeGreaterThanOrEqual(1);
    // The last draft PUT should be for ch-001 with null (cleared draft)
    const lastDraftPut = draftPuts[draftPuts.length - 1]!;
    const lastUrl = typeof lastDraftPut[0] === "string" ? lastDraftPut[0] : (lastDraftPut[0] as Request).url;
    expect(lastUrl).toContain("ch-001");
    const body = JSON.parse((lastDraftPut[1] as RequestInit).body as string);
    expect(body.draft).toBeNull();
  });

  it("does not clear existing draft on page load", async () => {
    const fetchMock = vi.mocked(fetch);

    // Override channels mock to include a draft
    const channelsWithDraft = [
      { id: "ch-001-full-uuid", createdAt: "2026-03-28T09:00:00Z", draft: "saved draft" },
      { id: "ch-002-full-uuid", createdAt: "2026-03-28T09:01:00Z" },
    ];
    fetchMock.mockImplementation(async (url) => {
      const urlStr = typeof url === "string" ? url : (url as Request).url;
      if (urlStr.includes("/api/channels") && !urlStr.includes("/messages")) {
        return { ok: true, json: () => Promise.resolve(channelsWithDraft) } as Response;
      }
      if (urlStr.includes("/messages")) {
        return { ok: true, json: () => Promise.resolve(mockMessages) } as Response;
      }
      if (urlStr.includes("/api/status")) {
        return { ok: true, json: () => Promise.resolve(mockStatus) } as Response;
      }
      if (urlStr.includes("/api/logs")) {
        return { ok: true, json: () => Promise.resolve([]) } as Response;
      }
      if (urlStr.includes("/draft")) {
        return { ok: true, json: () => Promise.resolve({ status: "saved" }) } as Response;
      }
      return { ok: false, json: () => Promise.resolve({}) } as Response;
    });

    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );

    // Wait for initial render and draft restore
    await waitFor(() => {
      expect(screen.getAllByText("ch-001-f").length).toBeGreaterThanOrEqual(1);
    });

    // Advance time well past the debounce period to catch any accidental save
    vi.advanceTimersByTime(3000);

    // Verify no draft PUT was made (empty initial state should not overwrite saved draft)
    const draftPuts = fetchMock.mock.calls.filter((c) => {
      const urlStr = typeof c[0] === "string" ? c[0] : (c[0] as Request).url;
      const init = c[1] as RequestInit | undefined;
      return urlStr.includes("/draft") && init?.method === "PUT";
    });
    expect(draftPuts.length).toBe(0);
  });

  it("shows status bar with version info", async () => {
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getAllByText(/gateway: v0\.30\.0/).length).toBeGreaterThanOrEqual(1);
    });
  });

  it("updates sessionStatus via session_status_change SSE event", async () => {
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );

    // Wait for channel SSE to connect
    await waitFor(() => {
      expect(getChannelSse()).not.toBeUndefined();
    });

    const src = getChannelSse()!;

    // Dispatch a session_status_change event with status "processing"
    src.onmessage?.({
      data: JSON.stringify({
        type: "session_status_change",
        data: { sessionId: "sess-001", status: "processing" },
      }),
    });

    await waitFor(() => {
      // The session status should be reflected in the status bar
      expect(screen.getAllByText(/processing/).length).toBeGreaterThanOrEqual(1);
    });
  });

  it("ignores session_status_change SSE event when data.status is missing", async () => {
    render(
      <MemoryRouter initialEntries={["/?channel=ch-001-full-uuid"]}>
        <DashboardPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(getChannelSse()).not.toBeUndefined();
    });

    const src = getChannelSse()!;

    // Establish a known session status via session_status_change with a valid status
    src.onmessage?.({
      data: JSON.stringify({
        type: "session_status_change",
        data: { sessionId: "sess-001", status: "idle" },
      }),
    });

    await waitFor(() => {
      expect(screen.getAllByText(/idle/).length).toBeGreaterThanOrEqual(1);
    });

    // Dispatch a session_status_change event WITHOUT a status field
    src.onmessage?.({
      data: JSON.stringify({
        type: "session_status_change",
        data: { sessionId: "sess-001" },
      }),
    });

    // sessionStatus should remain "idle" and "processing" must NOT appear in the status bar
    await waitFor(() => {
      const statusBar = screen.getByText(/gateway: v/);
      expect(statusBar).toHaveTextContent(/idle/);
      expect(statusBar).not.toHaveTextContent(/processing/);
    });
  });

  it("uses derivedStatus over raw status when both are present in session_status_change", async () => {
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(getChannelSse()).not.toBeUndefined();
    });

    const src = getChannelSse()!;

    // Dispatch a session_status_change event with both status and derivedStatus
    src.onmessage?.({
      data: JSON.stringify({
        type: "session_status_change",
        data: { sessionId: "sess-001", status: "processing", derivedStatus: "running" },
      }),
    });

    await waitFor(() => {
      // derivedStatus "running" should be displayed, not raw "processing"
      expect(screen.getAllByText(/running/).length).toBeGreaterThanOrEqual(1);
    });
  });

  it("falls back to raw status when derivedStatus is absent in session_status_change", async () => {
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(getChannelSse()).not.toBeUndefined();
    });

    const src = getChannelSse()!;

    // Dispatch without derivedStatus — should fall back to raw status
    src.onmessage?.({
      data: JSON.stringify({
        type: "session_status_change",
        data: { sessionId: "sess-001", status: "waiting" },
      }),
    });

    await waitFor(() => {
      expect(screen.getAllByText(/waiting/).length).toBeGreaterThanOrEqual(1);
    });
  });

  it("updates agentVersion via agent_status_change on global SSE", async () => {
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );

    // Wait for global SSE to connect
    await waitFor(() => {
      expect(getGlobalSse()).not.toBeUndefined();
    });

    const globalSrc = getGlobalSse()!;

    // Dispatch agent_status_change with a new version
    globalSrc.onmessage?.({
      data: JSON.stringify({
        type: "agent_status_change",
        version: "0.99.0",
        running: true,
      }),
    });

    await waitFor(() => {
      expect(screen.getAllByText(/0\.99\.0/).length).toBeGreaterThanOrEqual(1);
    });
  });

  it("updates compatibility via agent_compatibility_change on global SSE", async () => {
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(getGlobalSse()).not.toBeUndefined();
    });

    const globalSrc = getGlobalSse()!;

    // Dispatch agent_compatibility_change
    globalSrc.onmessage?.({
      data: JSON.stringify({
        type: "agent_compatibility_change",
        compatibility: "incompatible",
      }),
    });

    await waitFor(() => {
      expect(screen.getAllByText(/incompatible/).length).toBeGreaterThanOrEqual(1);
    });
  });

  it("channel SSE and global SSE are independent (different URLs)", async () => {
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(getChannelSse()).not.toBeUndefined();
      expect(getGlobalSse()).not.toBeUndefined();
    });

    // Verify they are distinct instances
    expect(getChannelSse()).not.toBe(getGlobalSse());
    expect(getChannelSse()!.url).toContain("/api/events?channel=");
    expect(getGlobalSse()!.url).toBe("/api/global-events");
  });

  it("adds log entries to logs state via global SSE log_appended event", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(getGlobalSse()).not.toBeUndefined();
    });

    // Open the logs panel
    const logsBtn = screen.getAllByText("Logs")[0]!;
    await user.click(logsBtn);

    // Wait for the initial snapshot fetch to complete
    await waitFor(() => {
      expect(screen.getByText(/Logs/)).toBeInTheDocument();
    });

    const globalSrc = getGlobalSse()!;

    // Dispatch a log_appended event
    globalSrc.onmessage?.({
      data: JSON.stringify({
        type: "log_appended",
        entries: [
          { timestamp: "2026-04-14T10:00:00.000Z", source: "gateway", level: "info", message: "sse-log-entry" },
        ],
      }),
    });

    await waitFor(() => {
      expect(screen.getAllByText(/sse-log-entry/).length).toBeGreaterThanOrEqual(1);
    });
  });

  it("respects 200-entry ring buffer cap when receiving log_appended events", async () => {
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(getGlobalSse()).not.toBeUndefined();
    });

    const globalSrc = getGlobalSse()!;

    // Inject 210 entries one by one
    for (let i = 0; i < 210; i++) {
      globalSrc.onmessage?.({
        data: JSON.stringify({
          type: "log_appended",
          entries: [
            { timestamp: `2026-04-14T10:00:${String(i).padStart(2, "0")}.000Z`, source: "gateway", level: "info", message: `entry-${i}` },
          ],
        }),
      });
    }

    // Give React time to process state updates
    await waitFor(() => {
      // The oldest entries (entry-0 through entry-9) should be evicted
      const allLogText = document.body.textContent ?? "";
      // Count log entries — should be at most 200
      const matchCount = (allLogText.match(/entry-/g) ?? []).length;
      expect(matchCount).toBeLessThanOrEqual(200);
    });
  });

  describe("channel_list_change global SSE event", () => {
    it("updates channels state when channel_list_change arrives", async () => {
      render(
        <MemoryRouter>
          <DashboardPage />
        </MemoryRouter>,
      );

      await waitFor(() => {
        expect(getGlobalSse()).not.toBeUndefined();
      });

      const globalSrc = getGlobalSse()!;

      // Dispatch channel_list_change with new channel list (3 channels)
      globalSrc.onmessage?.({
        data: JSON.stringify({
          type: "channel_list_change",
          channels: [
            { id: "ch-001-full-uuid", createdAt: "2026-03-28T09:00:00Z" },
            { id: "ch-002-full-uuid", createdAt: "2026-03-28T09:01:00Z" },
            { id: "ch-003-full-uuid", createdAt: "2026-03-28T09:02:00Z" },
          ],
        }),
      });

      await waitFor(() => {
        expect(screen.getAllByText("ch-003-f").length).toBeGreaterThanOrEqual(1);
      });
    });

    it("filters out archived channels when showArchived is false (default)", async () => {
      render(
        <MemoryRouter>
          <DashboardPage />
        </MemoryRouter>,
      );

      await waitFor(() => {
        expect(getGlobalSse()).not.toBeUndefined();
      });

      const globalSrc = getGlobalSse()!;

      // Send a list that includes an archived channel
      globalSrc.onmessage?.({
        data: JSON.stringify({
          type: "channel_list_change",
          channels: [
            { id: "ch-001-full-uuid", createdAt: "2026-03-28T09:00:00Z" },
            { id: "ch-archived-uuid", createdAt: "2026-03-28T09:01:00Z", archivedAt: "2026-04-01T00:00:00Z" },
          ],
        }),
      });

      // Wait briefly for state to settle
      await waitFor(() => {
        // ch-archived should not be visible (filtered out by showArchived=false)
        expect(screen.queryByText("ch-archi")).toBeNull();
      });
      // ch-001 should still be visible
      expect(screen.getAllByText("ch-001-f").length).toBeGreaterThanOrEqual(1);
    });

    it("falls back to first channel when active channel is absent after channel_list_change", async () => {
      render(
        <MemoryRouter initialEntries={["/?channel=ch-002-full-uuid"]}>
          <DashboardPage />
        </MemoryRouter>,
      );

      await waitFor(() => {
        expect(getGlobalSse()).not.toBeUndefined();
      });

      const globalSrc = getGlobalSse()!;

      // Send a list that does NOT include the current active channel (ch-002-full-uuid)
      globalSrc.onmessage?.({
        data: JSON.stringify({
          type: "channel_list_change",
          channels: [
            { id: "ch-001-full-uuid", createdAt: "2026-03-28T09:00:00Z" },
          ],
        }),
      });

      // After the event, ch-001 should become active (setSearchParams fallback)
      await waitFor(() => {
        expect(screen.getAllByText("ch-001-f").length).toBeGreaterThanOrEqual(1);
      });
    });
  });

  it("does not use polling for logs (fetchLogs not called on timer advances)", async () => {
    const fetchMock = vi.mocked(fetch);

    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getAllByText("Hello agent").length).toBeGreaterThanOrEqual(1);
    });

    // Count /api/logs calls before timer advance
    const logCallsBefore = fetchMock.mock.calls.filter((c) => {
      const urlStr = typeof c[0] === "string" ? c[0] : (c[0] as Request).url;
      return urlStr.includes("/api/logs");
    }).length;

    // Advance time by 9 seconds — under old polling this would trigger 3 calls
    vi.advanceTimersByTime(9000);

    const logCallsAfter = fetchMock.mock.calls.filter((c) => {
      const urlStr = typeof c[0] === "string" ? c[0] : (c[0] as Request).url;
      return urlStr.includes("/api/logs");
    }).length;

    // No new /api/logs calls should have been triggered by timer advance
    expect(logCallsAfter).toBe(logCallsBefore);
  });
});
