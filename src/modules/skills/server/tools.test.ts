import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { SkillNotAvailable } from "../errors.ts";
import type { SkillManifestEntry } from "../schema.ts";
import { projectSkillToolResult, SkillActivity, SKILL_ACTIVITY_LIMITS } from "../tool-schema.ts";
import { SKILL_LIMITS } from "../package.ts";
import { prepareSkillTools } from "./tools.ts";
import { SkillReader } from "./reader.ts";
const entry: SkillManifestEntry = {
  skillId: "one",
  revisionId: "revision-one",
  name: "review",
  description: "Review carefully",
  manualOnly: false,
  explicit: true,
};
function setup(manifest: SkillManifestEntry[] = [entry], rootChars = 10000) {
  let revoked = false;
  const documents = new Map([
    ["SKILL.md", "PRIVATE ROOT INSTRUCTIONS"],
    ["references/notes.md", `${"a".repeat(7999)}😀ending`],
  ]);
  const reader = SkillReader.of({
    catalogue: () => Effect.succeed([]),
    authorize: (_userId, ids) =>
      revoked && ids.length ? Effect.fail(new SkillNotAvailable({ skillId: "one" })) : Effect.void,
    readPinned: (_userId, pinned, path) => {
      expect(pinned.revisionId).toBe("revision-one");
      return revoked
        ? Effect.fail(new SkillNotAvailable({ skillId: "one" }))
        : Effect.succeed(documents.get(path) ?? null);
    },
  });
  const prepare = Effect.runPromise(
    prepareSkillTools({ userId: "user", manifest, maxRootChars: rootChars }).pipe(
      Effect.provideService(SkillReader, reader),
    ),
  );
  return {
    prepare,
    revoke: () => {
      revoked = true;
    },
    restore: () => {
      revoked = false;
    },
  };
}
describe("private skill execution", () => {
  it("preloads explicit instructions once and never repeats them in tool output", async () => {
    const session = await setup().prepare;
    expect(JSON.stringify(session.messages()).match(/PRIVATE ROOT INSTRUCTIONS/g)).toHaveLength(1);
    const loaded = await Effect.runPromise(session.group.handlers.load_skill({ skillId: "one" }));
    expect(loaded.content).toBe("");
    const read = await Effect.runPromise(
      session.group.handlers.read_skill_file({ skillId: "one", path: "SKILL.md", offset: 0 }),
    );
    expect(read.ok).toBe(false);
    expect(read.content).toBe("");
  });
  it("does not offer or automatically load manual-only attached skills", async () => {
    const session = await setup([{ ...entry, explicit: false, manualOnly: true }]).prepare;
    expect(JSON.stringify(session.messages())).not.toContain("PRIVATE ROOT INSTRUCTIONS");
    expect(
      await Effect.runPromise(session.group.handlers.load_skill({ skillId: "one" })),
    ).toMatchObject({ ok: false });
  });
  it("rejects explicit roots rather than truncating required guidance", async () => {
    await expect(setup([entry], 2).prepare).rejects.toThrow();
  });
  it("returns exact UTF-16 continuation boundaries", async () => {
    const session = await setup().prepare;
    const read = session.group.handlers.read_skill_file;
    const first = await Effect.runPromise(
      read({ skillId: "one", path: "references/notes.md", offset: 0 }),
    );
    expect(first.content).toHaveLength(7999);
    expect(first.nextOffset).toBe(7999);
    const next = await Effect.runPromise(
      read({ skillId: "one", path: "references/notes.md", offset: first.nextOffset! }),
    );
    expect(next.content).toBe("😀ending");
    expect(next.nextOffset).toBeNull();
    expect(
      await Effect.runPromise(read({ skillId: "one", path: "references/notes.md", offset: 8000 })),
    ).toMatchObject({ ok: false });
  });
  it("treats missing files as recoverable but authorization loss as sticky", async () => {
    const control = setup();
    const session = await control.prepare;
    expect(
      await Effect.runPromise(
        session.group.handlers.read_skill_file({ skillId: "one", path: "missing.md", offset: 0 }),
      ),
    ).toMatchObject({ ok: false });
    control.revoke();
    await expect(Effect.runPromise(session.authorize())).rejects.toThrow();
    control.restore();
    await expect(Effect.runPromise(session.authorize())).rejects.toThrow();
  });
  it("charges repeated and refused calls against a single operation budget", async () => {
    const session = await setup().prepare;
    for (let index = 0; index < SKILL_LIMITS.operations; index++)
      await Effect.runPromise(session.group.handlers.load_skill({ skillId: "unknown" }));
    // The budget is spent, which the next call reports for itself.
    expect(
      await Effect.runPromise(
        session.group.handlers.read_skill_file({
          skillId: "one",
          path: "references/notes.md",
          offset: 0,
        }),
      ),
    ).toMatchObject({ ok: false, remainingOps: 0 });
  });
  it("offers library skills for discovery without making them dependencies", async () => {
    const ambient: SkillManifestEntry = {
      skillId: "two",
      revisionId: "revision-two",
      name: "brand-guidelines",
      description: "Our brand voice and colours",
      manualOnly: false,
      explicit: false,
      ambient: true,
    };
    const control = setup([ambient]);
    const session = await control.prepare;
    const prompt = session.messages()[0]!.content as string;
    // Visible to the model, with an instruction that makes it act on a match.
    expect(prompt).toContain("brand-guidelines");
    expect(prompt).toContain("call load_skill");
    // Losing access to a skill nobody selected must not end the turn.
    control.revoke();
    await Effect.runPromise(session.authorize());
  });
  it("projects only summary fields, never private content", async () => {
    const session = await setup().prepare;
    const result = await Effect.runPromise(
      session.group.handlers.read_skill_file({
        skillId: "one",
        path: "references/notes.md",
        offset: 7999,
      }),
    );
    const activity = projectSkillToolResult("read_skill_file", result);
    expect(JSON.stringify(activity)).not.toContain("😀ending");
    expect(activity).not.toHaveProperty("content");
  });
  it("bounds every displayed field so a row can never carry package text", () => {
    const activity = projectSkillToolResult("read_skill_file", {
      ok: false,
      skillId: "s".repeat(400),
      name: "n".repeat(400),
      path: "p".repeat(400),
      content: "private body",
      nextOffset: null,
      remainingOps: 3,
      error: "e".repeat(900),
    })!;
    expect(Schema.is(SkillActivity)(activity)).toBe(true);
    expect([
      activity.skillId.length,
      activity.skillName.length,
      activity.path.length,
      activity.error!.length,
    ]).toEqual([
      SKILL_ACTIVITY_LIMITS.id,
      SKILL_ACTIVITY_LIMITS.name,
      SKILL_ACTIVITY_LIMITS.path,
      SKILL_ACTIVITY_LIMITS.error,
    ]);
    expect(JSON.stringify(activity)).not.toContain("private body");
  });
});
