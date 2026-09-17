import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig, type Plugin } from "vite";

// Dev only. Nitro's Vite middleware guesses whether a request is a static
// asset from `sec-fetch-dest`: anything that is neither `empty` nor a document
// dest is handed to Vite's static layer and never reaches the app, so an
// `<img src="/api/files/:id">` 404s while `fetch()` on the same URL works
// (nitro/dist/_build/vite.dev.mjs). Our /api routes are always app routes, so
// drop the hint before the heuristic sees it. The built server routes them
// directly and needs none of this.
const apiRoutesAreNeverAssets = (): Plugin => ({
  name: "api-routes-are-never-assets",
  apply: "serve",
  enforce: "pre",
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url?.startsWith("/api/")) delete req.headers["sec-fetch-dest"];
      next();
    });
  },
});

export default defineConfig({
  server: {
    port: Number(process.env.PORT ?? 3000),
    host: "127.0.0.1",
    strictPort: true,
    allowedHosts: process.env.PORTLESS_URL ? [new URL(process.env.PORTLESS_URL).hostname] : [],
  },
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    apiRoutesAreNeverAssets(),
    tanstackStart({ spa: { enabled: true } }),
    nitro(),
    viteReact(),
    tailwindcss(),
  ],
});
