import { execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";

const serverDirectory = resolve(".output/server");

const findModules = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedModules = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return findModules(path);
      if (entry.isFile() && entry.name.endsWith(".mjs")) return [path];
      return [];
    }),
  );

  return nestedModules.flat();
};

let modules;
try {
  modules = (await findModules(serverDirectory)).toSorted();
} catch (error) {
  console.error(`Could not inspect ${relative(process.cwd(), serverDirectory)}.`);
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

if (modules.length === 0) {
  console.error("No production server modules were emitted.");
  process.exit(1);
}

for (const modulePath of modules) {
  try {
    execFileSync(process.execPath, ["--check", modulePath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    console.error(`Invalid server module: ${relative(process.cwd(), modulePath)}`);
    if (error && typeof error === "object" && "stderr" in error) {
      console.error(String(error.stderr).trim());
    } else {
      console.error(error);
    }
    process.exit(1);
  }
}

const runtimeCandidates = (
  await Promise.all(
    modules.map(async (modulePath) => ({
      modulePath,
      source: await readFile(modulePath, "utf8"),
    })),
  )
)
  .filter(({ source }) => source.includes("chat/custom-tools/CustomToolRuntime"))
  .map(({ modulePath }) => modulePath);
if (runtimeCandidates.length !== 1) {
  throw new Error(`Expected one emitted custom tool runtime, found ${runtimeCandidates.length}.`);
}
const { CustomToolRuntime } = await import(pathToFileURL(runtimeCandidates[0]).href);
const compiled = `
const { Schema } = require("effect");
module.exports = { default: {
  ping: {
    name: "Ping",
    description: "Return the supplied value.",
    parameters: Schema.Struct({ value: Schema.String }),
    run: ({ value }) => ({ pong: value }),
  },
} };
`;
const customToolSmoke = Effect.gen(function* () {
  const runtime = yield* CustomToolRuntime;
  const functions = yield* runtime.inspect({ compiled, slug: "smoke" });
  const result = yield* runtime.run({
    compiled,
    functionKey: "ping",
    args: { value: "production" },
    timeoutMs: 5_000,
  });
  return { functions, result };
}).pipe(Effect.provide(CustomToolRuntime.layer));
const originalDirectory = process.cwd();
const alternateDirectory = await mkdtemp(join(tmpdir(), "chat-custom-tool-worker-"));
let customToolResult;
try {
  process.chdir(alternateDirectory);
  customToolResult = await Effect.runPromise(customToolSmoke);
} finally {
  process.chdir(originalDirectory);
  await rm(alternateDirectory, { recursive: true, force: true });
}
if (
  customToolResult.functions[0]?.modelName !== "custom_smoke__ping" ||
  !customToolResult.result.ok ||
  JSON.parse(customToolResult.result.output).pong !== "production"
) {
  throw new Error(`Unexpected production custom tool result: ${JSON.stringify(customToolResult)}`);
}
console.log("Checked the production custom tool worker.");

const publicDirectory = resolve(".output/public");
const shell = await readFile(resolve(publicDirectory, "_shell.html"), "utf8");
if (!shell.includes("Loading Chat…") || !shell.includes('id="desktop-titlebar-content"')) {
  throw new Error("The production SPA shell is missing its startup frame.");
}
const assets = new Set(
  Array.from(shell.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)[^"]*"/g), (match) => match[1]),
);
if (assets.size === 0) throw new Error("The production SPA shell has no application assets.");
await Promise.all(Array.from(assets, (asset) => access(resolve(publicDirectory, `.${asset}`))));
console.log(
  `Checked ${modules.length} production server modules and the SPA shell (${assets.size} assets).`,
);
