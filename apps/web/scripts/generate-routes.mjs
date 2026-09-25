import { createServer } from "vite";

// src/routeTree.gen.ts is gitignored and only the router's Vite plugin writes
// it, so a fresh checkout cannot typecheck or test until something has
// started Vite. Starting and closing a server runs exactly that plugin.
const server = await createServer({
  server: { middlewareMode: true, hmr: false, watch: null },
  logLevel: "warn",
});
await server.close();
