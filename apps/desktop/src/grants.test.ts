import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { GrantStore } from "./grants.ts";

const at = (origin: string, conversationId: string) => ({ origin, conversationId });
const here = (conversationId: string) => at("https://chat.test", conversationId);
const rw = (path: string) => ({ path, readOnly: false });

describe("GrantStore", () => {
  it("forgets one conversation without touching another", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const grants = yield* GrantStore;
        yield* grants.remember(here("removed"), "/tmp/removed");
        yield* grants.remember(here("kept"), "/tmp/kept");
        yield* grants.forgetAll(here("removed"));
        expect(yield* grants.lookup(here("removed"))).toEqual([]);
        expect(yield* grants.lookup(here("kept"))).toEqual([rw("/tmp/kept")]);
      }).pipe(Effect.provide(GrantStore.layerEphemeral)),
    );
  });

  it("keeps the same conversation id apart across servers", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const grants = yield* GrantStore;
        yield* grants.remember(at("https://one.test", "shared"), "/tmp/one");
        expect(yield* grants.lookup(at("https://two.test", "shared"))).toEqual([]);
        yield* grants.forgetAll(at("https://two.test", "shared"));
        expect(yield* grants.lookup(at("https://one.test", "shared"))).toEqual([rw("/tmp/one")]);
      }).pipe(Effect.provide(GrantStore.layerEphemeral)),
    );
  });

  it("writes the last mutation, not a stale overlapping snapshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chat-grants-"));
    const file = join(dir, "folders.json");
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const grants = yield* GrantStore;
          yield* Effect.all(
            [
              grants.remember(here("a"), "/tmp/a"),
              grants.forget(here("a"), "/tmp/a"),
              grants.remember(here("b"), "/tmp/b"),
            ],
            { concurrency: "unbounded" },
          );
          expect(yield* grants.lookup(here("a"))).toEqual([]);
          expect(yield* grants.lookup(here("b"))).toEqual([rw("/tmp/b")]);
        }).pipe(Effect.provide(GrantStore.layerAt(file))),
      );
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
        "https://chat.test b": ["/tmp/b"],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("drops entries written before the origin was part of the key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chat-grants-"));
    const file = join(dir, "folders.json");
    try {
      await writeFile(
        file,
        JSON.stringify({ old: ["/tmp/old"], "https://chat.test kept": ["/tmp/kept"] }),
      );
      await Effect.runPromise(
        Effect.gen(function* () {
          const grants = yield* GrantStore;
          expect(yield* grants.lookup(here("old"))).toEqual([]);
          expect(yield* grants.lookup(here("kept"))).toEqual([rw("/tmp/kept")]);
        }).pipe(Effect.provide(GrantStore.layerAt(file))),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps read-only beside the path and reads a bare path as read-write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chat-grants-"));
    const file = join(dir, "folders.json");
    try {
      await writeFile(
        file,
        JSON.stringify({
          "https://chat.test a": ["/tmp/plain", { path: "/tmp/ro", readOnly: true }, 3, {}],
        }),
      );
      await Effect.runPromise(
        Effect.gen(function* () {
          const grants = yield* GrantStore;
          expect(yield* grants.lookup(here("a"))).toEqual([
            rw("/tmp/plain"),
            { path: "/tmp/ro", readOnly: true },
          ]);
          // Choosing a folder again takes the new mode and keeps its place.
          yield* grants.remember(here("a"), "/tmp/plain", true);
          yield* grants.remember(here("a"), "/tmp/ro");
        }).pipe(Effect.provide(GrantStore.layerAt(file))),
      );
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
        "https://chat.test a": [{ path: "/tmp/plain", readOnly: true }, "/tmp/ro"],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
