import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["test/browser/**", "node_modules/**"],
    env: {
      // Redirect state directories to repo tmp/ to avoid polluting the home directory
      COPILOTCLAW_STATE_ROOT: join(import.meta.dirname, "..", "..", "tmp", "test-state", "gateway"),
    },
  },
});
