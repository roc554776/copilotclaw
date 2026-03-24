import { describe, expect, it } from "vitest";
import { randomNumberTool } from "../../src/tools/random-number.js";

describe("randomNumberTool", () => {
  it("has correct name and required parameters", () => {
    expect(randomNumberTool.name).toBe("random_number");
    const params = randomNumberTool.parameters as Record<string, unknown>;
    expect(params).toMatchObject({
      type: "object",
      required: ["min", "max"],
    });
  });

  it("returns a value between min and max inclusive", () => {
    const invocation = { sessionId: "s", toolCallId: "t", toolName: "random_number", arguments: {} };
    for (let i = 0; i < 50; i++) {
      const result = randomNumberTool.handler({ min: 5, max: 10 }, invocation) as { value: number };
      expect(result.value).toBeGreaterThanOrEqual(5);
      expect(result.value).toBeLessThanOrEqual(10);
      expect(Number.isInteger(result.value)).toBe(true);
    }
  });

  it("returns the only possible value when min equals max", () => {
    const invocation = { sessionId: "s", toolCallId: "t", toolName: "random_number", arguments: {} };
    const result = randomNumberTool.handler({ min: 7, max: 7 }, invocation) as { value: number };
    expect(result.value).toBe(7);
  });
});
