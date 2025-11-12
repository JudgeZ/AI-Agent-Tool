import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globals: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      all: true,
      thresholds: {
        lines: 65,
        statements: 65,
        functions: 60,
        branches: 50
      }
    }
  }
});
