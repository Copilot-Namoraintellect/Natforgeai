import { defineConfig } from "vitest/config";
import path from "path";

const templateRoot = path.resolve(import.meta.dirname);

export default defineConfig({
  root: templateRoot,
  resolve: {
    alias: {
      "@": path.resolve(templateRoot, "src"),
      "@contracts": path.resolve(templateRoot, "contracts"),
      "@assets": path.resolve(templateRoot, "attached_assets"),
      "@db": path.resolve(templateRoot, "db"),
    },
  },
  test: {
    environment: "node",
    testTimeout: 10000,
    include: [
      "api/**/*.test.ts",
      "api/**/*.test.tsx",
      "api/**/*.spec.ts",
      "api/**/*.spec.tsx",
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "src/**/*.spec.ts",
      "src/**/*.spec.tsx",
      "db/**/*.test.ts",
      "db/**/*.test.tsx",
      "db/**/*.spec.ts",
      "db/**/*.spec.tsx",
      "scripts/**/*.test.ts",
      "scripts/**/*.test.tsx",
      "scripts/**/*.spec.ts",
      "scripts/**/*.spec.tsx",
    ],
  },
});
