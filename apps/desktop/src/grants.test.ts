import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { DRAFT_CONVERSATION } from "@chat/desktop-rpc";
import { GrantStore } from "./grants.ts";

const at = (origin: string, conversationId: string) => ({ origin, conversationId });
const here = (conversationId: string) => at("https://chat.test", conversationId);

describe("GrantStore", () => {
  it("forgets the draft key without touching other conversations", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const grants = yield* GrantStore;
        yield* grants.remember(here(DRAFT_CONVERSATION), "/tmp/draft");
        yield* grants.remember(here("kept"), "/tmp/kept");
        yield* grants.forgetAll(here(DRAFT_CONVERSATION));
        expect(yield* grants.lookup(here(DRAFT_CONVERSATION))).toEqual([]);
        expect(yield* grants.lookup(here("kept"))).toEqual(["/tmp/kept"]);
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
        expect(yield* grants.lookup(at("https://one.test", "shared"))).toEqual(["/tmp/one"]);
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
          expect(yield* grants.lookup(here("b"))).toEqual(["/tmp/b"]);
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
          expect(yield* grants.lookup(here("kept"))).toEqual(["/tmp/kept"]);
        }).pipe(Effect.provide(GrantStore.layerAt(file))),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
