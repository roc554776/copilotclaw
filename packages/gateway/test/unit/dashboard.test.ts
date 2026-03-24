import { describe, expect, it } from "vitest";
import { renderDashboard } from "../../src/dashboard.js";
import type { UserInput } from "../../src/store.js";

describe("renderDashboard", () => {
  it("renders empty state when no inputs", () => {
    const html = renderDashboard([]);
    expect(html).toContain("Send a message to start the conversation.");
    expect(html).toContain("copilotclaw");
  });

  it("renders input without reply as pending", () => {
    const inputs: UserInput[] = [
      { id: "test-id", message: "hello", createdAt: "2026-01-01T00:00:00Z" },
    ];
    const html = renderDashboard(inputs);
    expect(html).toContain("hello");
    expect(html).toContain("thinking…");
    expect(html).toContain("user-bubble");
  });

  it("renders input with reply as chat bubbles", () => {
    const inputs: UserInput[] = [
      {
        id: "test-id",
        message: "question",
        createdAt: "2026-01-01T00:00:00Z",
        reply: { message: "answer", createdAt: "2026-01-01T00:00:01Z" },
      },
    ];
    const html = renderDashboard(inputs);
    expect(html).toContain("question");
    expect(html).toContain("answer");
    expect(html).toContain("agent-bubble");
    expect(html).not.toContain("thinking…");
  });

  it("escapes HTML in user input", () => {
    const inputs: UserInput[] = [
      { id: "xss", message: '<script>alert("xss")</script>', createdAt: "2026-01-01T00:00:00Z" },
    ];
    const html = renderDashboard(inputs);
    expect(html).toContain("&lt;script&gt;");
    // The dashboard itself contains a <script> tag for interactivity,
    // but user content must be escaped
    expect(html).not.toContain('alert("xss")');
    expect(html).toContain("alert(&quot;xss&quot;)");
  });

  it("renders input area with textarea and send button", () => {
    const html = renderDashboard([]);
    expect(html).toContain("input-area");
    expect(html).toContain("<textarea");
    expect(html).toContain("Send");
  });
});
