import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { DRAFT_CONVERSATION } from "@chat/desktop-rpc";
import { GrantStore } from "./grants.ts";

describe("GrantStore", () => {
  it("forgets the draft key without touching other conversations", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const grants = yield* GrantStore;
        yield* grants.remember(DRAFT_CONVERSATION, "/tmp/draft");
        yield* grants.remember("kept", "/tmp/kept");
        yield* grants.forgetAll(DRAFT_CONVERSATION);
        expect(yield* grants.lookup(DRAFT_CONVERSATION)).toEqual([]);
        expect(yield* grants.lookup("kept")).toEqual(["/tmp/kept"]);
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
              grants.remember("a", "/tmp/a"),
              grants.forget("a", "/tmp/a"),
              grants.remember("b", "/tmp/b"),
            ],
            { concurrency: "unbounded" },
          );
          expect(yield* grants.lookup("a")).toEqual([]);
          expect(yield* grants.lookup("b")).toEqual(["/tmp/b"]);
        }).pipe(Effect.provide(GrantStore.layerAt(file))),
      );
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ b: ["/tmp/b"] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
