import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
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
]);
