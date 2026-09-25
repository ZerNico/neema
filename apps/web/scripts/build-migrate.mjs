import { cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const at = (path) => fileURLToPath(new URL(path, import.meta.url));

await build({
  entryPoints: [at("./migrate.mjs")],
  outfile: at("../.output/migrate.mjs"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  // pg requires its optional native binding lazily and only when asked for it.
  external: ["pg-native"],
  // Bundled CommonJS (pg) still calls `require` for Node builtins.
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
await cp(at("../drizzle"), at("../.output/drizzle"), { recursive: true });
