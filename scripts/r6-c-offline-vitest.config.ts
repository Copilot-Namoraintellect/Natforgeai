import { fileURLToPath } from "node:url";
import { mergeConfig } from "vitest/config";
import base from "../vitest.config";

// Opt-in verification only; normal application and test configuration is unchanged.
export default mergeConfig(base, {
  test: {
    setupFiles: [fileURLToPath(new URL("./r6-c-offline-verification.setup.ts", import.meta.url))],
    hookTimeout: 30_000,
    maxWorkers: 2,
  },
});
