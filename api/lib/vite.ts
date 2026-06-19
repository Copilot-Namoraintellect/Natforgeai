import type { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import fs from "fs";
import path from "path";

type App = Hono<{ Bindings: HttpBindings }>;

export function serveStaticFiles(app: App) {
  const distPath = path.resolve(import.meta.dirname, "../dist/public");

  app.use("*", serveStatic({ root: "./dist/public" }));

  app.notFound((c) => {
    const accept = c.req.header("accept") ?? "";
    if (!accept.includes("text/html")) {
      return c.json({ error: "Not Found" }, 404);
    }
    const indexPath = path.resolve(distPath, "index.html");
    const content = fs.readFileSync(indexPath, "utf-8");
    return c.html(content);
  });
}

/**
 * Serve generated media from a persistent directory outside dist/.
 * This keeps images/videos/uploads available across builds and deployments.
 */
export function servePersistentMedia(app: App) {
  const generatedDir = path.resolve(process.cwd(), "data/public/generated");
  const uploadsDir = path.resolve(process.cwd(), "data/public/uploads");

  if (!fs.existsSync(generatedDir)) {
    fs.mkdirSync(generatedDir, { recursive: true });
    console.log(`[Static] Created persistent generated directory: ${generatedDir}`);
  }
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
    console.log(`[Static] Created persistent uploads directory: ${uploadsDir}`);
  }

  app.use("/generated/*", serveStatic({ root: "./data/public/generated", rewriteRequestPath: (path) => path.replace(/^\/generated/, "") }));
  app.use("/uploads/*", serveStatic({ root: "./data/public/uploads", rewriteRequestPath: (path) => path.replace(/^\/uploads/, "") }));

  console.log(`[Static] Serving persistent media from ${generatedDir} and ${uploadsDir}`);
}
