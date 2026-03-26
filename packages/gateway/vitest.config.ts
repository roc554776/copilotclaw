import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["test/browser/**", "node_modules/**"],
  },
});
