import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Tests must never reach a live model, even if a key is present in the shell.
    env: { MODEL_PROVIDER: "fixture" },
  },
});
