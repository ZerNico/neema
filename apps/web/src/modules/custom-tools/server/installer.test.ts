import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer } from "effect";
import { CustomToolBuilder } from "./builder.ts";
import { CustomToolInstaller } from "./installer.ts";
import { CustomToolRuntime } from "./runtime.ts";

// Arborist's own tar and ssri, so the fixture tarballs and integrity strings
// are produced by exactly the code that will verify them.
const arboristRequire = createRequire(require.resolve("@npmcli/arborist"));
const tar = arboristRequire("tar") as {
  create(
    options: { gzip: true; cwd: string; portable: true },
    files: string[],
  ): NodeJS.ReadableStream;
};
const ssri = arboristRequire("ssri") as {
  fromData(data: Buffer, options: { algorithms: string[] }): { toString(): string };
};

interface FixturePackage {
  readonly name: string;
  readonly version: string;
  readonly files: Record<string, string>;
  readonly published: Date;
  readonly dependencies?: Record<string, string>;
  readonly scripts?: Record<string, string>;
}

const dayMs = 24 * 60 * 60 * 1000;
const old = new Date(Date.now() - 30 * dayMs);
const fresh = new Date(Date.now() - 60 * 1000);

/**
 * A packument-serving registry on loopback. Every package is one exact
 * version; `time` drives the release-age cutoff pacote applies.
 */
class FakeRegistry {
  readonly #packages = new Map<string, { packument: unknown; tarball: Buffer }>();
  #server: Server | undefined;
  origin = "";

  async add(pkg: FixturePackage): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "chat-registry-pkg-"));
    const manifest = {
      name: pkg.name,
      version: pkg.version,
      main: "index.js",
      ...("index.d.ts" in pkg.files ? { types: "index.d.ts" } : {}),
      ...(pkg.dependencies ? { dependencies: pkg.dependencies } : {}),
      ...(pkg.scripts ? { scripts: pkg.scripts } : {}),
    };
    await mkdir(join(root, "package"), { recursive: true });
    await writeFile(join(root, "package", "package.json"), JSON.stringify(manifest));
    for (const [file, content] of Object.entries(pkg.files)) {
      await writeFile(join(root, "package", file), content);
    }
    const chunks: Buffer[] = [];
    const sink = new PassThrough();
    sink.on("data", (chunk: Buffer) => chunks.push(chunk));
    await new Promise<void>((resolve, reject) => {
      tar
        .create({ gzip: true, cwd: root, portable: true }, ["package"])
        .on("error", reject)
        .pipe(sink)
        .on("finish", resolve);
    });
    const tarball = Buffer.concat(chunks);
    await rm(root, { recursive: true, force: true });
    const integrity = ssri.fromData(tarball, { algorithms: ["sha512"] }).toString();
    this.#packages.set(pkg.name, {
      tarball,
      packument: {
        name: pkg.name,
        "dist-tags": { latest: pkg.version },
        versions: {
          [pkg.version]: {
            ...manifest,
            dist: {
              integrity,
              tarball: `${this.origin}/${pkg.name}/-/${pkg.name}-${pkg.version}.tgz`,
            },
          },
        },
        time: { created: pkg.published.toISOString(), [pkg.version]: pkg.published.toISOString() },
      },
    });
  }

  async start(): Promise<void> {
    this.#server = createServer((request, response) => {
      const url = request.url ?? "/";
      const tarballMatch = /^\/([^/]+)\/-\/.+\.tgz$/.exec(url);
      const name = decodeURIComponent(tarballMatch ? tarballMatch[1]! : url.slice(1));
      const pkg = this.#packages.get(name);
      if (!pkg) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "Not found" }));
        return;
      }
      if (tarballMatch) {
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(pkg.tarball);
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(pkg.packument));
    });
    await new Promise<void>((resolve) => {
      this.#server!.listen(0, "127.0.0.1", () => {
        const address = this.#server!.address();
        this.origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()));
  }
}

const registry = new FakeRegistry();
let packageRoot: string;

beforeAll(async () => {
  await registry.start();
  packageRoot = await mkdtemp(join(tmpdir(), "chat-custom-tools-"));
  await registry.add({
    name: "greeter",
    version: "1.0.0",
    published: old,
    dependencies: { shouter: "2.0.0" },
    files: {
      "index.js":
        'const { shout } = require("shouter");\nmodule.exports = { greet: (name) => shout(`hello ${name}`) };\n',
      "index.d.ts": "export function greet(name: string): string;\n",
    },
  });
  await registry.add({
    name: "shouter",
    version: "2.0.0",
    published: old,
    files: { "index.js": "module.exports = { shout: (text) => text.toUpperCase() };\n" },
  });
  await registry.add({
    name: "too-new",
    version: "1.0.0",
    published: fresh,
    files: { "index.js": "module.exports = {};\n" },
  });
  await registry.add({
    name: "scripted",
    version: "1.0.0",
    published: old,
    scripts: { postinstall: "node -e \"require('fs').writeFileSync('SCRIPT_RAN', '1')\"" },
    files: {
      "index.js": "module.exports = { ran: true };\n",
      "index.d.ts": "export const ran: boolean;\n",
    },
  });
  await registry.add({
    name: "brings-effect",
    version: "1.0.0",
    published: old,
    dependencies: { effect: "3.0.0" },
    files: { "index.js": "module.exports = {};\n" },
  });
  await registry.add({
    name: "effect",
    version: "3.0.0",
    published: old,
    files: { "index.js": "module.exports = { legacy: true };\n" },
  });
});

afterAll(async () => {
  await registry.stop();
  await rm(packageRoot, { recursive: true, force: true });
});

const withCore = <A, E>(run: Effect.Effect<A, E, CustomToolBuilder | CustomToolRuntime>) => {
  const config = ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      CUSTOM_TOOL_PACKAGE_ROOT: packageRoot,
      CUSTOM_TOOL_WORKERS: 1,
      CUSTOM_TOOL_REGISTRY: registry.origin,
    }),
  );
  const dependencies = Layer.merge(CustomToolInstaller.layer, CustomToolRuntime.layer).pipe(
    Layer.provide(config),
  );
  return run.pipe(Effect.provide(CustomToolBuilder.layer.pipe(Layer.provideMerge(dependencies))));
};

const source = (pkg: string, body: string) => `
import { Schema, defineModule, defineTool } from "@chat/custom-tools";
import * as dep from "${pkg}";

export default defineModule({
  call: defineTool({
    name: "Call",
    description: "Call the dependency.",
    parameters: Schema.Struct({ name: Schema.String }),
    run: ({ name }) => ${body},
  }),
});
`;

describe("custom tool installer", () => {
  it.effect("installs an exact root with its transitive tree and bundles it", () =>
    withCore(
      Effect.gen(function* () {
        const builder = yield* CustomToolBuilder;
        const runtime = yield* CustomToolRuntime;
        const build = yield* builder.build({
          slug: "greet",
          source: source("greeter", "dep.greet(name)"),
          dependencies: [{ name: "greeter", version: "1.0.0" }],
        });
        expect(build.dependencies).toEqual([{ name: "greeter", version: "1.0.0" }]);
        // The transitive dependency is bundled, not left as an external.
        expect(build.compiled).toContain("toUpperCase");

        const result = yield* runtime.run({
          compiled: build.compiled,
          functionKey: "call",
          args: { name: "world" },
          timeoutMs: 5_000,
        });
        expect(result).toMatchObject({ ok: true, output: "HELLO WORLD" });
      }),
    ),
  );

  it.effect("fails the strict type check for a package without types", () =>
    withCore(
      Effect.gen(function* () {
        const builder = yield* CustomToolBuilder;
        const failure = yield* builder
          .build({
            slug: "untyped",
            source: source("shouter", "name"),
            dependencies: [{ name: "shouter", version: "2.0.0" }],
          })
          .pipe(Effect.flip);
        expect(failure.message).toContain("TypeScript check failed");
        expect(failure.message).toContain("declaration file for module 'shouter'");
      }),
    ),
  );

  it.effect("rejects a version published inside the release-age window", () =>
    withCore(
      Effect.gen(function* () {
        const builder = yield* CustomToolBuilder;
        const failure = yield* builder
          .build({
            slug: "fresh",
            source: source("too-new", "name"),
            dependencies: [{ name: "too-new", version: "1.0.0" }],
          })
          .pipe(Effect.flip);
        expect(failure.message).toContain("Dependency installation failed");
        expect(failure.message).toContain("too-new");
      }),
    ),
  );

  it.effect("never runs lifecycle scripts", () =>
    withCore(
      Effect.gen(function* () {
        const builder = yield* CustomToolBuilder;
        yield* builder.build({
          slug: "scripted",
          source: source("scripted", "name"),
          dependencies: [{ name: "scripted", version: "1.0.0" }],
        });
        const marker = yield* Effect.promise(() =>
          readdir(packageRoot, { recursive: true }).then((entries) =>
            entries.filter((entry) => String(entry).endsWith("SCRIPT_RAN")),
          ),
        );
        expect(marker).toEqual([]);
        // The build directory itself is gone once the scope closes.
        const builds = yield* Effect.promise(() => readdir(join(packageRoot, "builds")));
        expect(builds).toEqual([]);
      }),
    ),
  );

  it.effect("refuses a dependency that carries its own Effect", () =>
    withCore(
      Effect.gen(function* () {
        const builder = yield* CustomToolBuilder;
        const failure = yield* builder
          .build({
            slug: "conflict",
            source: source("brings-effect", "name"),
            dependencies: [{ name: "brings-effect", version: "1.0.0" }],
          })
          .pipe(Effect.flip);
        expect(failure.message).toContain("effect@3.0.0");
      }),
    ),
  );

  it.effect("reports a missing package", () =>
    withCore(
      Effect.gen(function* () {
        const builder = yield* CustomToolBuilder;
        const failure = yield* builder
          .build({
            slug: "missing",
            source: source("nope", "name"),
            dependencies: [{ name: "nope", version: "1.0.0" }],
          })
          .pipe(Effect.flip);
        expect(failure.message).toContain("Dependency installation failed");
        expect(failure.message).toContain("nope");
      }),
    ),
  );
});
