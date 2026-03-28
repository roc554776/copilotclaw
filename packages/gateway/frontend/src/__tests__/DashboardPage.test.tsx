import { render, screen, waitFor } from "@testing-library/react";
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

// Mock EventSource
class MockEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  close() {}
}

describe("DashboardPage", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    (globalThis as unknown as Record<string, unknown>).EventSource = MockEventSource;

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
      return { ok: false, json: () => Promise.resolve({}) } as Response;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (globalThis as unknown as Record<string, unknown>).EventSource;
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

  it("sends a message on Enter", async () => {
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

    const textareas = screen.getAllByPlaceholderText("Type a message...");
    const textarea = textareas[0]!;
    await user.type(textarea, "Test message{Enter}");

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

    const textareas = screen.getAllByPlaceholderText("Type a message...");
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
});
