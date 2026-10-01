import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const at = (path) => fileURLToPath(new URL(path, import.meta.url));

/**
 * Each job worker becomes one bundle beside the server output, named as its
 * runtime's `workerEntry` expects. `external` stays unbundled: the PowerPoint
 * renderer finds its fonts next to its own module, and resvg loads a native binding.
 */
const workers = [
  {
    source: "../src/modules/presentations/server/runtime-worker.ts",
    bundle: "presentation-worker.mjs",
    external: ["@office-kit/pptx", "@office-kit/pptx-preview/*", "@resvg/resvg-js"],
  },
  {
    source: "../src/modules/spreadsheets/server/runtime-worker.ts",
    bundle: "spreadsheet-worker.mjs",
  },
  {
    source: "../src/modules/word/server/runtime-worker.ts",
    bundle: "word-worker.mjs",
  },
];

await Promise.all(
  workers.map((worker) =>
    build({
      entryPoints: [at(worker.source)],
      outfile: at(`../.output/server/${worker.bundle}`),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      external: worker.external ?? [],
      logLevel: "warning",
    }),
  ),
);
