import { describe, expect, it } from "vitest";
import { renderDashboard } from "../../src/dashboard.js";
import type { UserInput } from "../../src/store.js";

describe("renderDashboard", () => {
  it("renders empty state when no inputs", () => {
    const html = renderDashboard([]);
    expect(html).toContain("No inputs yet");
    expect(html).toContain("copilotclaw gateway");
  });

  it("renders input without reply", () => {
    const inputs: UserInput[] = [
      { id: "test-id", message: "hello", createdAt: "2026-01-01T00:00:00Z" },
    ];
    const html = renderDashboard(inputs);
    expect(html).toContain("test-id");
    expect(html).toContain("hello");
    expect(html).toContain("waiting…");
  });

  it("renders input with reply", () => {
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
    expect(html).not.toContain("waiting…");
  });

  it("escapes HTML in user input", () => {
    const inputs: UserInput[] = [
      { id: "xss", message: '<script>alert("xss")</script>', createdAt: "2026-01-01T00:00:00Z" },
    ];
    const html = renderDashboard(inputs);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
