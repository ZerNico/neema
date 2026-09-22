import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import Arborist from "@npmcli/arborist";
import { Config, Context, Effect, Layer, Scope } from "effect";
import npa from "npm-package-arg";
import semver from "semver";
import { CustomToolCompileFailed } from "../errors.ts";
import { CUSTOM_TOOL_LIMITS, type CustomToolDependency } from "../schema.ts";

const releaseAgeMs = 24 * 60 * 60 * 1000;
const reservedPackages = new Set(["effect", "@chat/custom-tools"]);

export interface InstalledCustomToolProject {
  readonly root: string;
  readonly nodeModules: string;
  readonly dependencies: ReadonlyArray<CustomToolDependency>;
}

const compileFailure = (message: string) => new CustomToolCompileFailed({ message });

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export function validateCustomToolDependencies(
  dependencies: ReadonlyArray<CustomToolDependency>,
): ReadonlyArray<CustomToolDependency> {
  if (dependencies.length > CUSTOM_TOOL_LIMITS.dependencies) {
    throw new Error(
      `A module may declare at most ${CUSTOM_TOOL_LIMITS.dependencies} dependencies.`,
    );
  }

  const names = new Set<string>();
  return dependencies.map((dependency) => {
    if (reservedPackages.has(dependency.name)) {
      throw new Error(`${dependency.name} is supplied by the custom tool runtime.`);
    }
    if (names.has(dependency.name)) {
      throw new Error(`Dependency ${dependency.name} is declared more than once.`);
    }

    const parsed = npa.resolve(dependency.name, dependency.version);
    const exactVersion = semver.valid(dependency.version);
    if (parsed.type !== "version" || parsed.name !== dependency.name || exactVersion === null) {
      throw new Error(
        `Dependency ${dependency.name} must use an exact registry version, not ${JSON.stringify(dependency.version)}.`,
      );
    }

    names.add(dependency.name);
    return { name: dependency.name, version: exactVersion };
  });
}

/**
 * The build links the app's own Effect over node_modules/effect so the bundle
 * shares one runtime with the host. A dependency that brings its own copy
 * would be silently retargeted to a different major, so refuse it here rather
 * than let the type check fail somewhere inside it.
 */
const rejectBundledEffect = (tree: Arborist.Node): void => {
  for (const node of tree.inventory.values()) {
    if (node.location === "" || node.isRoot || node.isLink) continue;
    if (node.package.name === "effect") {
      throw new Error(
        `A declared dependency depends on effect@${node.package.version}; only the runtime's Effect is available.`,
      );
    }
  }
};

interface ArboristCutoffOptions extends Arborist.Options {
  readonly before: Date;
  readonly signal: AbortSignal;
}

export class CustomToolInstaller extends Context.Service<
  CustomToolInstaller,
  {
    install(
      dependencies: ReadonlyArray<CustomToolDependency>,
    ): Effect.Effect<InstalledCustomToolProject, CustomToolCompileFailed, Scope.Scope>;
  }
>()("chat/custom-tools/CustomToolInstaller") {
  static readonly layer = Layer.effect(
    CustomToolInstaller,
    Effect.gen(function* () {
      const configuredRoot = yield* Config.string("CUSTOM_TOOL_PACKAGE_ROOT").pipe(
        Config.withDefault(".data/custom-tools"),
        Effect.orDie,
      );
      // Registry base URL. Operators point this at a mirror or private
      // registry; the admin UI never sees it.
      const registry = yield* Config.string("CUSTOM_TOOL_REGISTRY").pipe(
        Config.withDefault("https://registry.npmjs.org"),
        Effect.orDie,
      );
      const packageRoot = resolve(configuredRoot);
      const cache = join(packageRoot, "cache");
      const builds = join(packageRoot, "builds");
      yield* Effect.tryPromise({
        try: () =>
          Promise.all([mkdir(cache, { recursive: true }), mkdir(builds, { recursive: true })]),
        catch: (cause) =>
          compileFailure(`Could not prepare the package store: ${errorMessage(cause)}`),
      });

      const install = Effect.fn("CustomToolInstaller.install")(function* (
        inputDependencies: ReadonlyArray<CustomToolDependency>,
      ) {
        const dependencies = yield* Effect.try({
          try: () => validateCustomToolDependencies(inputDependencies),
          catch: (cause) => compileFailure(errorMessage(cause)),
        });
        const root = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () => mkdtemp(join(builds, "build-")),
            catch: (cause) =>
              compileFailure(`Could not create a build directory: ${errorMessage(cause)}`),
          }),
          (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
        );

        return yield* Effect.tryPromise({
          try: async (signal) => {
            const packageJson = {
              name: "chat-custom-tool-build",
              private: true,
              version: "0.0.0",
              type: "module",
              dependencies: Object.fromEntries(
                dependencies.map((dependency) => [dependency.name, dependency.version]),
              ),
            };
            await writeFile(join(root, "package.json"), JSON.stringify(packageJson, null, 2));

            const options: ArboristCutoffOptions = {
              path: root,
              cache,
              registry,
              ignoreScripts: true,
              binLinks: false,
              packageLock: true,
              save: true,
              before: new Date(Date.now() - releaseAgeMs),
              signal,
            };
            rejectBundledEffect(await new Arborist(options).reify());
            return {
              root,
              nodeModules: join(root, "node_modules"),
              dependencies,
            } satisfies InstalledCustomToolProject;
          },
          catch: (cause) =>
            compileFailure(`Dependency installation failed: ${errorMessage(cause)}`),
        });
      });

      return CustomToolInstaller.of({ install });
    }),
  );
}
