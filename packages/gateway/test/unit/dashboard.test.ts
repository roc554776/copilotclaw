import { describe, expect, it } from "vitest";
import { renderDashboard } from "../../src/dashboard.js";
import type { Channel, Message } from "../../src/store.js";

const channel: Channel = { id: "ch-1", createdAt: "2026-01-01T00:00:00Z" };

describe("renderDashboard", () => {
  it("renders empty state when no messages", () => {
    const html = renderDashboard([channel], [], "ch-1");
    expect(html).toContain("Send a message to start the conversation.");
    expect(html).toContain("copilotclaw");
  });

  it("renders user message bubble", () => {
    const msgs: Message[] = [
      { id: "m1", channelId: "ch-1", sender: "user", message: "hello", createdAt: "2026-01-01T00:00:00Z" },
    ];
    const html = renderDashboard([channel], msgs, "ch-1");
    expect(html).toContain("hello");
    expect(html).toContain("user-bubble");
  });

  it("renders agent message bubble", () => {
    const msgs: Message[] = [
      { id: "m1", channelId: "ch-1", sender: "agent", message: "hi from agent", createdAt: "2026-01-01T00:00:00Z" },
    ];
    const html = renderDashboard([channel], msgs, "ch-1");
    expect(html).toContain("hi from agent");
    expect(html).toContain("agent-bubble");
  });

  it("escapes HTML in messages", () => {
    const msgs: Message[] = [
      { id: "xss", channelId: "ch-1", sender: "user", message: '<script>alert("xss")</script>', createdAt: "2026-01-01T00:00:00Z" },
    ];
    const html = renderDashboard([channel], msgs, "ch-1");
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

  it("renders processing indicator hidden by default", () => {
    const html = renderDashboard([channel], [], "ch-1");
    expect(html).toContain("processing-indicator");
    expect(html).toContain("typing-dots");
    // Element should have class="msg agent" (no "visible")
    expect(html).toContain('id="processing-indicator" class="msg agent"');
  });

  it("renders processing indicator visible when session is processing", () => {
    const html = renderDashboard([channel], [], "ch-1", { sessionStatus: "processing" });
    expect(html).toContain('id="processing-indicator" class="msg agent visible"');
  });

  it("renders processing indicator hidden when session is waiting", () => {
    const html = renderDashboard([channel], [], "ch-1", { sessionStatus: "waiting" });
    expect(html).toContain('id="processing-indicator" class="msg agent"');
    expect(html).not.toContain('id="processing-indicator" class="msg agent visible"');
  });
});
