import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "fast",
          include: ["tests/fast/**/*.test.ts"],
          environment: "node",
          testTimeout: 5_000,
        },
      },
      {
        test: {
          name: "smoke",
          include: ["tests/smoke/**/*.smoke.test.ts"],
          environment: "node",
          testTimeout: 240_000,
          hookTimeout: 240_000,
        },
      },
    ],
  },
});
