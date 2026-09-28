import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const at = (path) => fileURLToPath(new URL(path, import.meta.url));

// Keep Office packages external: the renderer locates its bundled fonts relative
// to its own module, and resvg loads a platform-specific native binding.
await build({
  entryPoints: [at("../src/modules/presentations/server/runtime-worker.ts")],
  outfile: at("../.output/server/presentation-worker.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["@office-kit/pptx", "@office-kit/pptx-preview/*", "@resvg/resvg-js"],
  logLevel: "warning",
});
