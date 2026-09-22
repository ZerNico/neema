import { isBuiltin } from "node:module";
import { fileURLToPath } from "node:url";
import { rolldown, type OutputChunk } from "rolldown";
import type { Plugin } from "vite";

const sources = {
  "virtual:custom-tool-runtime-worker": {
    entry: "./src/modules/custom-tools/server/runtime-worker.ts",
    format: "cjs",
  },
  "virtual:custom-tool-authoring-runtime": {
    entry: "./src/modules/custom-tools/authoring.ts",
    format: "esm",
  },
} as const;

const bundleAsString = async (
  entry: string,
  format: "cjs" | "esm",
): Promise<{ code: string; modules: ReadonlyArray<string> }> => {
  const bundle = await rolldown({
    input: fileURLToPath(new URL(entry, import.meta.url)),
    external: (specifier) => specifier === "effect" || isBuiltin(specifier),
  });
  try {
    const generated = await bundle.generate({ format, sourcemap: format === "cjs" && "inline" });
    const chunks = generated.output.filter(
      (output): output is OutputChunk => output.type === "chunk",
    );
    if (chunks.length !== 1 || generated.output.some((output) => output.type === "asset")) {
      throw new Error(`${entry} must build as one JavaScript chunk.`);
    }
    return { code: chunks[0]!.code, modules: Object.keys(chunks[0]!.modules) };
  } finally {
    await bundle.close();
  }
};

/**
 * Serves two Node-side sources as strings: the worker thread entry (CommonJS,
 * evaluated by `new Worker(source, { eval: true })`) and the `@chat/custom-tools`
 * runtime that the builder inlines into every authored bundle. Bundling the
 * real modules keeps them one copy of the code rather than a string that has
 * to be edited alongside it.
 */
export const customToolRuntimeWorker = (): Plugin => ({
  name: "custom-tool-runtime-worker",
  enforce: "pre",
  resolveId(id) {
    return id in sources ? `\0${id}` : null;
  },
  async load(id) {
    const key = id.startsWith("\0") ? id.slice(1) : id;
    if (!(key in sources)) return null;
    const { entry, format } = sources[key as keyof typeof sources];
    const { code, modules } = await bundleAsString(entry, format);
    // The string is a build of other files; without this Vite would serve
    // the first bundle for the rest of the dev session while those files
    // changed underneath it.
    for (const file of modules) if (!file.startsWith("\0")) this.addWatchFile(file);
    return `export default ${JSON.stringify(code)};`;
  },
});
