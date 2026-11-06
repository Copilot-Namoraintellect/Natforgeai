// Offline build only. Never starts boot/worker, deploys, or opens a database.
// Alternate verification bundle for restricted Windows worktrees where esbuild's
// native resolver cannot enumerate the parent directory. Not deployment packaging.
import { build } from "vite";
import { resolve } from "node:path";
await build({
  configFile: false,
  resolve: {
    alias: {
      "@db": resolve("db"),
      "@contracts": resolve("contracts"),
      "@": resolve("src"),
    },
  },
  build: {
    ssr: true,
    outDir: "dist/backend-verification",
    emptyOutDir: true,
    rollupOptions: {
      input: { boot: resolve("api/boot.ts"), worker: resolve("api/worker.ts") },
      external: [
        "ffmpeg-static",
        "sharp",
        "execa",
        "playwright",
        "playwright-core",
      ],
    },
  },
});
