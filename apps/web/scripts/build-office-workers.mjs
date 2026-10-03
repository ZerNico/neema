import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
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
  {
    // Native bindings load from their own packages; pdf.js stays one copy.
    source: "../src/modules/pdf/server/runtime-worker.ts",
    bundle: "pdf-worker.mjs",
    external: ["onnxruntime-node", "@napi-rs/canvas", "unpdf", "unpdf/*", "pdf-lib", "yaml"],
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

// onnxruntime-node ships every platform's binaries (about 290 MB); the output
// runs where it was built, so only this platform's are kept.
const onnxBinaries = at("../.output/server/node_modules/onnxruntime-node/bin/napi-v6");
const platforms = await readdir(onnxBinaries).catch(() => []);
for (const platform of platforms) {
  if (platform !== process.platform) {
    await rm(join(onnxBinaries, platform), { recursive: true, force: true });
    continue;
  }
  for (const arch of await readdir(join(onnxBinaries, platform)))
    if (arch !== process.arch)
      await rm(join(onnxBinaries, platform, arch), { recursive: true, force: true });
}
