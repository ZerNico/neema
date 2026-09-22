import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { isBuiltin, createRequire } from "node:module";
import { dirname, isAbsolute, join, relative } from "node:path";
import { Buffer } from "node:buffer";
import { Context, Duration, Effect, Layer, Option, Semaphore } from "effect";
import { VERSION as ROLLDOWN_VERSION, rolldown, type OutputChunk, type Plugin } from "rolldown";
import authoringRuntimeSource from "virtual:custom-tool-authoring-runtime";
import { CUSTOM_TOOL_AUTHORING_DECLARATION } from "../authoring-declaration.ts";
import { CUSTOM_TOOL_MODULE_ID } from "../authoring.ts";
import { CustomToolCompileFailed } from "../errors.ts";
import {
  CUSTOM_TOOL_LIMITS,
  type CustomToolDependency,
  type CustomToolFunctionManifest,
} from "../schema.ts";
import { CustomToolInstaller, type InstalledCustomToolProject } from "./installer.ts";
import { CustomToolRuntime } from "./runtime.ts";

const require = createRequire(import.meta.url);
const effectRoot = dirname(dirname(require.resolve("effect")));
const typescriptRoot = dirname(require.resolve("typescript/package.json"));
const typescriptCli = join(typescriptRoot, "bin", "tsc");
const nodeTypesRoot = dirname(dirname(require.resolve("@types/node/package.json")));
const effectVersion = (require(join(effectRoot, "package.json")) as { readonly version: string })
  .version;
const typescriptVersion = (
  require(join(typescriptRoot, "package.json")) as { readonly version: string }
).version;
const virtualModuleId = "\0chat-custom-tools";
const maxCachedBuilds = 32;
const maxCachedBuildBytes = 32 * 1024 * 1024;

export interface CustomToolBuild {
  readonly source: string;
  readonly dependencies: ReadonlyArray<CustomToolDependency>;
  readonly compiled: string;
  readonly functions: ReadonlyArray<CustomToolFunctionManifest>;
}

const compileFailure = (message: string) => new CustomToolCompileFailed({ message });

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const packageRoot = (specifier: string): string => {
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0]!;
};

const isInside = (parent: string, child: string): boolean => {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

const makeResolver = (
  project: InstalledCustomToolProject,
  entry: string,
  // Rolldown resolves through symlinks (macOS keeps /var under /private), so
  // the containment check has to compare real paths.
  nodeModules: string,
): Plugin => {
  const declaredRoots = new Set(project.dependencies.map((dependency) => dependency.name));
  return {
    name: "chat-custom-tool-resolver",
    resolveId: {
      order: "pre",
      async handler(specifier, importer) {
        if (specifier === CUSTOM_TOOL_MODULE_ID) return virtualModuleId;
        if (specifier === "effect" || isBuiltin(specifier)) {
          return { id: specifier, external: true };
        }
        if (specifier.startsWith("node:")) return { id: specifier, external: true };
        if (!importer) return null;
        if (importer === entry) {
          if (specifier.startsWith(".") || isAbsolute(specifier)) {
            throw new Error("Relative and absolute imports are not supported.");
          }
          const root = packageRoot(specifier);
          if (!declaredRoots.has(root)) {
            throw new Error(`Package ${root} is not declared as a dependency.`);
          }
        }
        const resolvedId = await this.resolve(specifier, importer, { skipSelf: true });
        if (!resolvedId) throw new Error(`Could not resolve ${JSON.stringify(specifier)}.`);
        if (!isInside(nodeModules, resolvedId.id)) {
          throw new Error(
            `Resolved module ${JSON.stringify(specifier)} escaped isolated node_modules.`,
          );
        }
        return resolvedId;
      },
    },
    load(id) {
      return id === virtualModuleId ? authoringRuntimeSource : null;
    },
  };
};

const linkRuntimePackages = (
  project: InstalledCustomToolProject,
): Effect.Effect<void, CustomToolCompileFailed> =>
  Effect.tryPromise({
    try: async () => {
      const effectLink = join(project.nodeModules, "effect");
      await mkdir(project.nodeModules, { recursive: true });
      await rm(effectLink, { recursive: true, force: true });
      await symlink(effectRoot, effectLink, "junction");
    },
    catch: (cause) => compileFailure(`Could not link the runtime packages: ${errorMessage(cause)}`),
  });

const writeTypecheckProject = (
  project: InstalledCustomToolProject,
  source: string,
): Effect.Effect<string, CustomToolCompileFailed> =>
  Effect.tryPromise({
    try: async () => {
      const entry = join(project.root, "tool.ts");
      const declaration = join(project.root, "chat-custom-tools.d.ts");
      const tsconfig = join(project.root, "tsconfig.json");
      await Promise.all([
        writeFile(entry, source),
        writeFile(declaration, CUSTOM_TOOL_AUTHORING_DECLARATION),
        writeFile(
          tsconfig,
          JSON.stringify(
            {
              compilerOptions: {
                target: "ES2024",
                module: "NodeNext",
                moduleResolution: "NodeNext",
                strict: true,
                noEmit: true,
                skipLibCheck: false,
                esModuleInterop: true,
                verbatimModuleSyntax: true,
                allowImportingTsExtensions: true,
                types: ["node"],
                typeRoots: [join(project.nodeModules, "@types"), nodeTypesRoot],
              },
              files: [entry, declaration],
            },
            null,
            2,
          ),
        ),
      ]);
      return entry;
    },
    catch: (cause) => compileFailure(`Could not prepare TypeScript: ${errorMessage(cause)}`),
  });

const runTypecheck = (
  project: InstalledCustomToolProject,
): Effect.Effect<void, CustomToolCompileFailed> =>
  Effect.tryPromise({
    try: (signal) =>
      new Promise<void>((resolvePromise, rejectPromise) => {
        execFile(
          process.execPath,
          [typescriptCli, "--project", join(project.root, "tsconfig.json"), "--pretty", "false"],
          {
            cwd: project.root,
            maxBuffer: 1024 * 1024,
            signal,
          },
          (error, stdout, stderr) => {
            if (!error) {
              resolvePromise();
              return;
            }
            const diagnostics = `${stdout}\n${stderr}`.trim();
            rejectPromise(new Error(diagnostics || error.message));
          },
        );
      }),
    catch: (cause) => compileFailure(`TypeScript check failed:\n${errorMessage(cause)}`),
  });

const bundleSource = (
  project: InstalledCustomToolProject,
  entry: string,
): Effect.Effect<string, CustomToolCompileFailed> =>
  Effect.tryPromise({
    try: async () => {
      const nodeModules = await realpath(project.nodeModules);
      const bundle = await rolldown({
        input: entry,
        cwd: project.root,
        plugins: [makeResolver(project, entry, nodeModules)],
        external: (specifier) => specifier === "effect" || isBuiltin(specifier),
      });
      try {
        const generated = await bundle.generate({
          format: "cjs",
          exports: "auto",
          sourcemap: "inline",
          codeSplitting: false,
        });
        const chunks = generated.output.filter(
          (output): output is OutputChunk => output.type === "chunk",
        );
        const assets = generated.output.filter((output) => output.type === "asset");
        if (chunks.length !== 1 || assets.length !== 0) {
          throw new Error(
            "A custom tool build must produce exactly one JavaScript chunk and no assets.",
          );
        }
        const chunk = chunks[0]!;
        const externals = [...chunk.imports, ...chunk.dynamicImports].filter(
          (specifier) => specifier !== "effect" && !isBuiltin(specifier),
        );
        if (externals.length > 0) {
          throw new Error(`The bundle left non-runtime externals: ${externals.join(", ")}.`);
        }
        const bytes = Buffer.byteLength(chunk.code);
        if (bytes > CUSTOM_TOOL_LIMITS.bundleBytes) {
          throw new Error(
            `The bundle is ${bytes} bytes; the limit is ${CUSTOM_TOOL_LIMITS.bundleBytes}.`,
          );
        }
        return chunk.code;
      } finally {
        await bundle.close();
      }
    },
    catch: (cause) => compileFailure(`Bundling failed: ${errorMessage(cause)}`),
  });

const buildCacheKey = (input: {
  readonly slug: string;
  readonly source: string;
  readonly dependencies: ReadonlyArray<CustomToolDependency>;
}): string =>
  createHash("sha256")
    .update(input.slug)
    .update("\0")
    .update(input.source)
    .update("\0")
    .update(JSON.stringify(input.dependencies))
    .update("\0")
    .update(
      JSON.stringify({
        node: process.version,
        effect: effectVersion,
        typescript: typescriptVersion,
        rolldown: ROLLDOWN_VERSION,
      }),
    )
    .digest("hex");

const buildCacheBytes = (build: CustomToolBuild): number =>
  Buffer.byteLength(JSON.stringify(build));

export class CustomToolBuilder extends Context.Service<
  CustomToolBuilder,
  {
    build(input: {
      readonly slug: string;
      readonly source: string;
      readonly dependencies: ReadonlyArray<CustomToolDependency>;
    }): Effect.Effect<CustomToolBuild, CustomToolCompileFailed>;
  }
>()("chat/custom-tools/CustomToolBuilder") {
  static readonly layer = Layer.effect(
    CustomToolBuilder,
    Effect.gen(function* () {
      const installer = yield* CustomToolInstaller;
      const runtime = yield* CustomToolRuntime;
      const builds = yield* Semaphore.make(2);
      const cache = new Map<string, { readonly build: CustomToolBuild; readonly bytes: number }>();
      let cachedBytes = 0;

      const buildUnbounded = Effect.fn("CustomToolBuilder.buildUnbounded")(function* (input: {
        readonly slug: string;
        readonly source: string;
        readonly dependencies: ReadonlyArray<CustomToolDependency>;
      }) {
        if (input.source.length > CUSTOM_TOOL_LIMITS.sourceChars) {
          return yield* compileFailure(
            `The source exceeds ${CUSTOM_TOOL_LIMITS.sourceChars} characters.`,
          );
        }
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const project = yield* installer.install(input.dependencies);
            yield* linkRuntimePackages(project);
            const entry = yield* writeTypecheckProject(project, input.source);
            yield* runTypecheck(project);
            const compiled = yield* bundleSource(project, entry);
            const functions = yield* runtime.inspect({
              compiled,
              slug: input.slug,
              timeoutMs: CUSTOM_TOOL_LIMITS.buildTimeoutMs,
            });
            return {
              source: input.source,
              dependencies: project.dependencies,
              compiled,
              functions,
            } satisfies CustomToolBuild;
          }),
        );
      });

      const build = Effect.fn("CustomToolBuilder.build")(function* (input: {
        readonly slug: string;
        readonly source: string;
        readonly dependencies: ReadonlyArray<CustomToolDependency>;
      }) {
        const key = buildCacheKey(input);
        const cached = cache.get(key);
        if (cached) {
          cache.delete(key);
          cache.set(key, cached);
          return cached.build;
        }

        // The deadline starts once a permit is held: a build queued behind
        // two slow installs should not be charged for their time.
        const result = yield* builds.withPermits(1)(
          buildUnbounded(input).pipe(
            Effect.timeoutOption(Duration.millis(CUSTOM_TOOL_LIMITS.buildTimeoutMs)),
          ),
        );
        if (Option.isNone(result)) {
          return yield* compileFailure(
            `The build did not finish within ${Math.round(CUSTOM_TOOL_LIMITS.buildTimeoutMs / 1000)} seconds.`,
          );
        }

        const bytes = buildCacheBytes(result.value);
        if (bytes <= maxCachedBuildBytes) {
          const replaced = cache.get(key);
          if (replaced) cachedBytes -= replaced.bytes;
          cache.set(key, { build: result.value, bytes });
          cachedBytes += bytes;
          while (cache.size > maxCachedBuilds || cachedBytes > maxCachedBuildBytes) {
            const oldestKey = cache.keys().next().value;
            if (oldestKey === undefined) break;
            const oldest = cache.get(oldestKey);
            cache.delete(oldestKey);
            if (oldest) cachedBytes -= oldest.bytes;
          }
        }
        return result.value;
      });

      return CustomToolBuilder.of({ build });
    }),
  );
}
