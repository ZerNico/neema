import { Effect, Schema } from "effect";
import { resolveSkillManifest, SkillRepo } from "~/modules/skills/server/repo.ts";
import { SkillReader } from "~/modules/skills/server/reader.ts";
import { Db } from "~/server/db.ts";
import { defineTool, refused, result } from "./define.ts";

/**
 * Every skill the person may read, their own and shared ones, the manual-only
 * included: picking one here is as explicit as pinning it. The built-ins are
 * not stored skills and are not listed; they drive this app's own tools.
 */
export const outsideSkills = (userId: string) =>
  Effect.flatMap(SkillRepo, (repo) => repo.list(userId));

/** One skill at its current revision, by id, under the same access check a pinned one gets. */
export const skillEntry = (userId: string, skillId: string) =>
  Effect.flatMap(Db, (db) =>
    db.transaction((tx) => resolveSkillManifest(tx, userId, [skillId], [])),
  ).pipe(
    Effect.map(([entry]) => entry ?? null),
    Effect.catchTag("SkillNotAvailable", () => Effect.succeed(null)),
    Effect.orDie,
  );

export const listSkills = defineTool({
  name: "list_skills",
  title: "List skills",
  description:
    "The skills this person may use: packaged instructions for a kind of task. Load one with read_skill_file and path SKILL.md, then follow it.",
  scope: "skills:read",
  input: Schema.Struct({}),
  annotations: { readOnlyHint: true, openWorldHint: false },
  run: (_args, { principal }) =>
    Effect.gen(function* () {
      // A manual-only skill is never offered on its own; it is a prompt the person picks.
      const skills = (yield* outsideSkills(principal.userId))
        .filter((skill) => !skill.manualOnly)
        .map((skill) => ({
          skillId: skill.id,
          name: skill.name,
          description: skill.description,
        }));
      return result(
        skills.length
          ? skills.map((s) => `- ${s.name} (${s.skillId}): ${s.description}`).join("\n")
          : "No skills.",
        { skills },
      );
    }),
});

export const readSkillFile = defineTool({
  name: "read_skill_file",
  title: "Read a skill's file",
  description:
    "Reads one text file of a skill: SKILL.md for its instructions, or a file those instructions name.",
  scope: "skills:read",
  input: Schema.Struct({
    skillId: Schema.String,
    path: Schema.optionalKey(Schema.String),
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  run: (args, { principal }) =>
    Effect.gen(function* () {
      const unavailable = refused("That skill isn't available to this account. Call list_skills.");
      const entry = yield* skillEntry(principal.userId, args.skillId);
      if (!entry) return yield* unavailable;
      const path = args.path ?? "SKILL.md";
      const file = yield* SkillReader.use((reader) =>
        reader.readPinned(principal.userId, entry, path),
      ).pipe(Effect.catchTag("SkillNotAvailable", () => Effect.fail(unavailable)));
      if (!file) return yield* refused(`${entry.name} has no file at ${path}.`);
      if (file.kind === "binary")
        return yield* refused(`${path} is a ${file.mediaType} file, which can't be read as text.`);
      return result(file.content, { skillId: entry.skillId, path, content: file.content });
    }),
});
