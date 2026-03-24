import { describe, expect, it } from "vitest";
import { renderDashboard } from "../../src/dashboard.js";
import type { Channel, UserInput } from "../../src/store.js";

const channel: Channel = { id: "ch-1", createdAt: "2026-01-01T00:00:00Z" };

describe("renderDashboard", () => {
  it("renders empty state when no inputs", () => {
    const html = renderDashboard([channel], [], "ch-1");
    expect(html).toContain("Send a message to start the conversation.");
    expect(html).toContain("copilotclaw");
  });

  it("renders input without reply as pending", () => {
    const inputs: UserInput[] = [
      { id: "test-id", channelId: "ch-1", message: "hello", createdAt: "2026-01-01T00:00:00Z" },
    ];
    const html = renderDashboard([channel], inputs, "ch-1");
    expect(html).toContain("hello");
    expect(html).toContain("thinking…");
  });

  it("renders input with reply as chat bubbles", () => {
    const inputs: UserInput[] = [
      {
        id: "test-id",
        channelId: "ch-1",
        message: "question",
        createdAt: "2026-01-01T00:00:00Z",
        reply: { message: "answer", createdAt: "2026-01-01T00:00:01Z" },
      },
    ];
    const html = renderDashboard([channel], inputs, "ch-1");
    expect(html).toContain("question");
    expect(html).toContain("answer");
    expect(html).not.toContain("thinking…");
  });

  it("escapes HTML in user input", () => {
    const inputs: UserInput[] = [
      { id: "xss", channelId: "ch-1", message: '<script>alert("xss")</script>', createdAt: "2026-01-01T00:00:00Z" },
    ];
    const html = renderDashboard([channel], inputs, "ch-1");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("alert(&quot;xss&quot;)");
  });

  it("renders channel tabs", () => {
    const ch2: Channel = { id: "ch-2", createdAt: "2026-01-01T00:01:00Z" };
    const html = renderDashboard([channel, ch2], [], "ch-1");
    expect(html).toContain("ch-1");
    expect(html).toContain("ch-2");
    expect(html).toContain("active");
  });

  it("renders new tab button", () => {
    const html = renderDashboard([channel], [], "ch-1");
    expect(html).toContain("new-tab");
  });
});
