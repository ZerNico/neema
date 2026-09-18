import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig, type Plugin } from "vite";

// Dev only. Nitro's Vite middleware guesses static-vs-app from `sec-fetch-dest`:
// neither `empty` nor document dest reaches Vite's static layer, so
// `<img src="/api/files/:id">` 404s while `fetch()` on the same URL works
// (nitro/dist/_build/vite.dev.mjs). /api routes are always app routes, so
// strip the hint first; the built server needs none of this.
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
