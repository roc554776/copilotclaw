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

// Mock EventSource — must be set on globalThis before component mounts
let lastMockEventSource: MockEventSource | null = null;

class MockEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  readyState = 1;
  constructor(_url: string) {
    // Track last created instance so tests can dispatch events
    lastMockEventSource = this;
  }
  close() {
    this.readyState = 2;
  }
}

// Set early so it's available even before beforeEach runs
(globalThis as unknown as Record<string, unknown>).EventSource = MockEventSource;

describe("DashboardPage", () => {
  beforeEach(() => {
    cleanup();
    lastMockEventSource = null;
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

    // Wait for initial render and status to be populated from /api/status poll
    await waitFor(() => {
      expect(lastMockEventSource).not.toBeNull();
    });

    const src = lastMockEventSource!;

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
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(lastMockEventSource).not.toBeNull();
    });

    const src = lastMockEventSource!;

    // First establish a known status via status_update
    src.onmessage?.({
      data: JSON.stringify({
        type: "status_update",
        data: {
          gatewayVersion: "0.68.1",
          agentVersion: "1.2.0",
          sessionStatus: "idle",
          compatibility: "compatible",
        },
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
      expect(lastMockEventSource).not.toBeNull();
    });

    const src = lastMockEventSource!;

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
      expect(lastMockEventSource).not.toBeNull();
    });

    const src = lastMockEventSource!;

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
});
