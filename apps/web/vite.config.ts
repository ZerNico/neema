import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import babel from "@rolldown/plugin-babel";
import viteReact, { reactCompilerPreset } from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig, type Plugin } from "vite";
import { customToolRuntimeWorker } from "./custom-tool-runtime-worker-plugin.ts";

// Dev only. Nitro's Vite middleware guesses static-vs-app from `sec-fetch-dest`:
// neither `empty` nor document dest reaches Vite's static layer, so
// `<img src="/api/files/:id">` 404s while `fetch()` on the same URL works
// (nitro/dist/_build/vite.dev.mjs). /api and /.well-known are always app
// routes, so strip the hint first; the built server needs none of this.
const apiRoutesAreNeverAssets = (): Plugin => ({
  name: "api-routes-are-never-assets",
  apply: "serve",
  enforce: "pre",
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url?.startsWith("/api/") || req.url?.startsWith("/.well-known/")) {
        delete req.headers["sec-fetch-dest"];
      }
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
    // Server-owned state lives here: blobs, and custom tool builds, which
    // install node_modules and write a tsconfig.json. Vite force-reloads every
    // client on any tsconfig.json it sees change, so a Check would reload the page.
    watch: { ignored: ["**/.data/**"] },
  },
  resolve: {
    tsconfigPaths: true,
  },
  // The code highlight Worker loads each grammar with a dynamic import, which
  // only an ES module Worker bundle can split out. Every Worker here is a module.
  worker: { format: "es" },
  plugins: [
    apiRoutesAreNeverAssets(),
    customToolRuntimeWorker(),
    tanstackStart({ spa: { enabled: true } }),
    nitro({
      rollupConfig: { external: [/^@npmcli\/arborist(?:\/|$)/] },
      // The custom tool builder resolves these from disk at runtime: tsc, and
      // the effect and Node declarations it checks tool modules against. A full
      // trace copies one package, so the declarations' own dependency is listed.
      traceDeps: [
        "@npmcli/arborist*",
        "typescript*",
        "effect*",
        "@types/node*",
        "undici-types*",
        "@office-kit/pptx*",
        "@resvg/resvg-js*",
        "fontkit*",
        // The PDF worker bundle leaves these external; the canvas pattern also
        // matches its platform package, and pdf-lib's dependencies are listed.
        "unpdf*",
        "onnxruntime-node*",
        "onnxruntime-common*",
        "@napi-rs/canvas*",
        "pdf-lib*",
        "@pdf-lib/*",
        "yaml*",
        "pako*",
        "tslib*",
      ],
    }),
    viteReact(),
    // React Compiler memoizes components and hooks, so a parent's render leaves unchanged
    // children alone. The preset runs only on modules with components or hooks in them.
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
  ],
});
