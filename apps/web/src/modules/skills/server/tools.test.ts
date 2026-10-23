import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { SkillNotAvailable } from "../errors.ts";
import type { SkillManifestEntry } from "../schema.ts";
import { projectSkillToolResult, SkillActivity, SKILL_ACTIVITY_LIMITS } from "../tool-schema.ts";
import { SKILL_LIMITS } from "../package.ts";
import { earlierSkillMessage, prepareSkillTools } from "./tools.ts";
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
  let readFailure: "unavailable" | "defect" | null = null;
  const documents = new Map([
    ["SKILL.md", "PRIVATE ROOT INSTRUCTIONS"],
    ["references/notes.md", `${"a".repeat(7999)}😀ending`],
  ]);
  const binaries = new Map([
    [
      "assets/master.pptx",
      {
        mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        size: 4096,
      },
    ],
  ]);
  const reader = SkillReader.of({
    catalogue: () => Effect.succeed([]),
    authorize: (_userId, ids) =>
      revoked && ids.length ? Effect.fail(new SkillNotAvailable({ skillId: "one" })) : Effect.void,
    readPinned: (_userId, pinned, path) => {
      expect(pinned.revisionId).toBe(
        manifest.find((candidate) => candidate.skillId === pinned.skillId)?.revisionId,
      );
      if (readFailure === "defect") return Effect.die(new Error("Blob read failed"));
      return revoked || readFailure === "unavailable"
        ? Effect.fail(new SkillNotAvailable({ skillId: pinned.skillId }))
        : Effect.succeed(
            binaries.has(path)
              ? { kind: "binary" as const, ...binaries.get(path)! }
              : documents.has(path)
                ? { kind: "text" as const, content: documents.get(path)! }
                : null,
          );
    },
    readPinnedBytes: () => Effect.die(new Error("tools never read bytes")),
    canReadRevision: () => Effect.succeed(true),
    listFiles: () => Effect.succeed([]),
  });
  const prepare = Effect.runPromise(
    prepareSkillTools({ userId: "user", manifest, maxRootChars: rootChars }).pipe(
      Effect.provideService(SkillReader, reader),
    ),
  );
  return {
    prepare,
    documents,
    revoke: () => {
      revoked = true;
    },
    denyReads: () => {
      readFailure = "unavailable";
    },
    crashReads: () => {
      readFailure = "defect";
    },
    restore: () => {
      revoked = false;
      readFailure = null;
    },
  };
}
const unavailable = { _tag: "SkillNotAvailable", skillId: "one" };

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
  it("hands a binary file over as an exact reference, never as content", async () => {
    const session = await setup().prepare;
    const read = await Effect.runPromise(
      session.group.handlers.read_skill_file({
        skillId: "one",
        path: "assets/master.pptx",
        offset: 0,
      }),
    );
    expect(read).toMatchObject({
      ok: true,
      path: "assets/master.pptx",
      nextOffset: null,
      file: {
        ref: "skill:revision-one/assets/master.pptx",
        mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        size: 4096,
      },
    });
    // What persists is the usual label: no reference, no body.
    expect(projectSkillToolResult("read_skill_file", read)).not.toHaveProperty("file");
  });
  it("offers an attached manual-only skill without ever preloading it", async () => {
    const session = await setup([{ ...entry, explicit: false, fromAgent: true, manualOnly: true }])
      .prepare;
    // Attaching is a preference, not a pin: the root stays out of the prompt
    // until the model asks for it.
    expect(JSON.stringify(session.messages())).not.toContain("PRIVATE ROOT INSTRUCTIONS");
    expect(
      await Effect.runPromise(session.group.handlers.load_skill({ skillId: "one" })),
    ).toMatchObject({ ok: true });
  });
  it("rejects explicit roots rather than truncating required guidance", async () => {
    await expect(setup([entry], 2).prepare).rejects.toMatchObject({
      _tag: "SkillRejected",
      reason: "Required instructions do not fit the reserved model context; nothing was truncated.",
    });
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
    await expect(Effect.runPromise(session.authorize())).rejects.toMatchObject(unavailable);
    control.restore();
    await expect(Effect.runPromise(session.authorize())).rejects.toMatchObject(unavailable);
  });
  it("answers a malformed call with what was wrong instead of failing the answer", async () => {
    const session = await setup().prepare;
    const missing = await Effect.runPromise(
      session.group.handlers.read_skill_file({ skillId: "one", path: "references/notes.md" }),
    );
    expect(missing).toMatchObject({ ok: false, error: expect.stringMatching(/offset/) });
    expect(
      await Effect.runPromise(session.group.handlers.load_skill({ skillId: "x".repeat(129) })),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/at most 128/) });
    expect(session.remaining()).toBe(SKILL_LIMITS.operations);
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
  it("recovers when an ambient skill is revoked before loading", async () => {
    const control = setup([{ ...entry, explicit: false, ambient: true }]);
    const session = await control.prepare;
    control.revoke();
    expect(
      await Effect.runPromise(session.group.handlers.load_skill({ skillId: "one" })),
    ).toMatchObject({ ok: false, content: "", error: "Skill is no longer available." });
    expect(JSON.stringify(session.messages())).not.toContain("PRIVATE ROOT INSTRUCTIONS");
    await Effect.runPromise(session.authorize());
    control.restore();
    expect(
      await Effect.runPromise(session.group.handlers.load_skill({ skillId: "one" })),
    ).toMatchObject({ ok: true });
    expect(JSON.stringify(session.messages())).toContain("PRIVATE ROOT INSTRUCTIONS");
  });
  it("recovers when an ambient supporting-file read loses access", async () => {
    const control = setup([{ ...entry, explicit: false, ambient: true }]);
    const session = await control.prepare;
    await Effect.runPromise(session.group.handlers.load_skill({ skillId: "one" }));
    control.revoke();
    const read = () =>
      session.group.handlers.read_skill_file({
        skillId: "one",
        path: "references/notes.md",
        offset: 7999,
      });
    expect(await Effect.runPromise(read())).toMatchObject({ ok: false, content: "" });
    await Effect.runPromise(session.authorize());
    control.restore();
    expect(await Effect.runPromise(read())).toMatchObject({ ok: true, content: "😀ending" });
  });
  it("keeps agent root-read authorization failures sticky", async () => {
    const control = setup([{ ...entry, explicit: false, fromAgent: true }]);
    const session = await control.prepare;
    control.denyReads();
    await expect(
      Effect.runPromise(session.group.handlers.load_skill({ skillId: "one" })),
    ).rejects.toMatchObject(unavailable);
    control.restore();
    await expect(Effect.runPromise(session.authorize())).rejects.toMatchObject(unavailable);
  });
  it.each(["explicit", "agent"] as const)(
    "keeps %s supporting-file authorization failures sticky",
    async (selection) => {
      const control = setup([
        { ...entry, explicit: selection === "explicit", fromAgent: selection === "agent" },
      ]);
      const session = await control.prepare;
      await Effect.runPromise(session.group.handlers.load_skill({ skillId: "one" }));
      control.denyReads();
      await expect(
        Effect.runPromise(
          session.group.handlers.read_skill_file({
            skillId: "one",
            path: "references/notes.md",
            offset: 0,
          }),
        ),
      ).rejects.toMatchObject(unavailable);
      control.restore();
      await expect(Effect.runPromise(session.authorize())).rejects.toMatchObject(unavailable);
    },
  );
  it("distinguishes a missing ambient root from unavailability", async () => {
    const control = setup([{ ...entry, explicit: false, ambient: true }]);
    const session = await control.prepare;
    control.documents.delete("SKILL.md");
    expect(
      await Effect.runPromise(session.group.handlers.load_skill({ skillId: "one" })),
    ).toMatchObject({ ok: false, error: "Required SKILL.md is missing." });
    await Effect.runPromise(session.authorize());
  });
  it("does not turn ambient read defects into unavailable-skill results", async () => {
    const control = setup([{ ...entry, explicit: false, ambient: true }]);
    const session = await control.prepare;
    control.crashReads();
    await expect(
      Effect.runPromise(session.group.handlers.load_skill({ skillId: "one" })),
    ).rejects.toThrow("Blob read failed");
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

describe("agent-attached skills", () => {
  // The prompt text itself, not the JSON envelope, so an assertion about the
  // catalogue is not written against escaped quotes.
  const promptOf = (session: { messages: () => Array<{ content: unknown }> }) =>
    session
      .messages()
      .map((message) => String(message.content))
      .join("\n");

  const agentSkill: SkillManifestEntry = {
    skillId: "one",
    revisionId: "revision-one",
    name: "review",
    description: "Review carefully",
    manualOnly: false,
    explicit: false,
    fromAgent: true,
  };

  it("offers them on demand and marks them, rather than preloading them", async () => {
    const session = await setup([agentSkill]).prepare;
    const prompt = promptOf(session);
    // Not preloaded: an agent attachment is a preference, not a pin.
    expect(prompt).not.toMatch(/PRIVATE ROOT INSTRUCTIONS/);
    expect(prompt).toMatch(/forThisAgent/);
    expect(prompt).toMatch(/Prefer them when more than one skill fits/);
    const loaded = await Effect.runPromise(session.group.handlers.load_skill({ skillId: "one" }));
    expect(loaded.ok).toBe(true);
    expect(promptOf(session)).toMatch(/PRIVATE ROOT INSTRUCTIONS/);
  });

  it("says nothing about agents when none of the entries came from one", async () => {
    const session = await setup([{ ...agentSkill, fromAgent: false, ambient: true }]).prepare;
    expect(promptOf(session)).not.toMatch(/forThisAgent|Prefer them/);
  });

  it("still hides a manual-only skill that is merely offered from the library", async () => {
    const session = await setup([
      { ...agentSkill, manualOnly: true, fromAgent: false, ambient: true },
    ]).prepare;
    expect(promptOf(session)).not.toMatch(/"skillId":"one"/);
    const loaded = await Effect.runPromise(session.group.handlers.load_skill({ skillId: "one" }));
    expect(loaded.ok).toBe(false);
    expect(loaded.error).toMatch(/not in this attempt's automatic catalogue/);
  });
});

describe("skills an earlier answer loaded", () => {
  const library: SkillManifestEntry = { ...entry, explicit: false, ambient: true };

  it("reads only what this attempt could load itself, skipping pinned and unavailable ones", async () => {
    const pinned = await setup([entry]).prepare;
    expect(await Effect.runPromise(pinned.readEarlier(["one", "gone"]))).toEqual(new Map());
    const control = setup([library]);
    const session = await control.prepare;
    expect(await Effect.runPromise(session.readEarlier(["one"]))).toEqual(
      new Map([["one", "PRIVATE ROOT INSTRUCTIONS"]]),
    );
    control.denyReads();
    expect(await Effect.runPromise(session.readEarlier(["one"]))).toEqual(new Map());
    // A replay that cannot be read is simply absent; the attempt still runs.
    await Effect.runPromise(session.authorize());
  });

  it("treats a replayed skill as loaded without repeating its text", async () => {
    const session = await setup([library]).prepare;
    session.setEarlier(new Set(["one"]));
    const prompt = JSON.stringify(session.messages());
    expect(prompt).toContain("Already loaded earlier in this conversation");
    expect(prompt).not.toContain("PRIVATE ROOT INSTRUCTIONS");
    expect(prompt).not.toMatch(/Available skills: \[\{/);
    const loaded = await Effect.runPromise(session.group.handlers.load_skill({ skillId: "one" }));
    expect(loaded).toMatchObject({ ok: true, content: "" });
    expect(JSON.stringify(session.messages())).not.toContain("PRIVATE ROOT INSTRUCTIONS");
    const read = await Effect.runPromise(
      session.group.handlers.read_skill_file({
        skillId: "one",
        path: "references/notes.md",
        offset: 0,
      }),
    );
    expect(read.ok).toBe(true);
    // Once compaction drops the replay, the skill is offered again.
    session.setEarlier(new Set());
    expect(JSON.stringify(session.messages())).not.toContain("Already loaded earlier");
    await Effect.runPromise(session.group.handlers.load_skill({ skillId: "one" }));
    expect(JSON.stringify(session.messages())).toContain("PRIVATE ROOT INSTRUCTIONS");
  });

  it("renders a replay from its inputs alone, so history stays byte-identical", () => {
    const message = earlierSkillMessage("one", "PRIVATE ROOT INSTRUCTIONS");
    expect(message).toEqual(earlierSkillMessage("one", "PRIVATE ROOT INSTRUCTIONS"));
    expect(message.role).toBe("user");
    expect(message.content).toContain(
      '<skill-guidance id="one">\nPRIVATE ROOT INSTRUCTIONS\n</skill-guidance>',
    );
  });
});
