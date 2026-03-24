import { describe, it } from "vitest";

// Agent tests require mocking @github/copilot-sdk to avoid:
// - Authentication requirements (GitHub token)
// - Risk of rate limiting / BAN from real API calls
// These tests are pending until a Copilot SDK mock layer is implemented.

describe("session idle loop", () => {
  it.skip("blocks stop with configured probability", () => {
    // TODO: mock CopilotClient and CopilotSession to test idle loop logic
  });

  it.skip("respects MAX_RETRIES limit", () => {
    // TODO: mock session.idle events and verify loop terminates at MAX_RETRIES
  });

  it.skip("handles session.error gracefully", () => {
    // TODO: mock session.error event and verify promise rejection
  });
});
