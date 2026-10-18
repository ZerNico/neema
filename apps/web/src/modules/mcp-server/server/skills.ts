import { McpServer, ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import { Effect } from "effect";
import type { SkillSummary } from "~/modules/skills/schema.ts";
import { SkillReader } from "~/modules/skills/server/reader.ts";
import type { SkillRepo } from "~/modules/skills/server/repo.ts";
import type { Db } from "~/server/db.ts";
import type { McpPrincipal } from "./auth.ts";
import type { McpRun } from "./tools/define.ts";
import { outsideSkills, skillEntry } from "./tools/skills.ts";

/**
 * A prompt name per skill: its own name where no other skill takes it, else
 * its id, which nothing else can share. A name that could then still clash
 * (a skill named like another's id) falls back to the id as well.
 */
const count = (names: ReadonlyArray<string>) => {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return counts;
};

export const promptNames = (skills: ReadonlyArray<SkillSummary>) => {
  const byName = count(skills.map((skill) => skill.name));
  let names = skills.map((skill) => (byName.get(skill.name) === 1 ? skill.name : skill.id));
  const again = count(names);
  names = names.map((name, index) => (again.get(name) === 1 ? name : skills[index]!.id));
  return skills.map((skill, index) => ({ skill, name: names[index]! }));
};

/**
 * Each skill this person may use as a prompt that loads its `SKILL.md`.
 * Answered by hand rather than registered: the skills are read only when a
 * client asks for prompts, never for every other request, and read again
 * when one is fetched, so a skill unshared since the list gives nothing.
 */
export const installSkillPrompts = (
  server: McpServer,
  env: { principal: McpPrincipal; run: McpRun<SkillReader | SkillRepo | Db> },
) => {
  const userId = env.principal.userId;
  const named = (signal: AbortSignal) => env.run(outsideSkills(userId), signal).then(promptNames);
  server.server.registerCapabilities({ prompts: {} });
  server.server.setRequestHandler("prompts/list", async (_request, context) => ({
    prompts: (await named(context.mcpReq.signal)).map(({ skill, name }) => ({
      name,
      title: skill.name,
      description: skill.description,
    })),
  }));
  server.server.setRequestHandler("prompts/get", async (request, context) => {
    const signal = context.mcpReq.signal;
    const found = (await named(signal)).find(({ name }) => name === request.params.name);
    const loaded = found
      ? await env.run(
          Effect.gen(function* () {
            const entry = yield* skillEntry(userId, found.skill.id);
            if (!entry) return null;
            const root = yield* Effect.flatMap(SkillReader, (skills) =>
              skills.readPinned(userId, entry, "SKILL.md"),
            ).pipe(Effect.catchTag("SkillNotAvailable", () => Effect.succeed(null)));
            return root?.kind === "text" ? { entry, content: root.content } : null;
          }),
          signal,
        )
      : null;
    if (!loaded)
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, "There is no such skill any more.");
    const { entry, content } = loaded;
    return {
      description: entry.description,
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Use the skill “${entry.name}” (skillId ${entry.skillId}). Files it names can be read with read_skill_file.\n\n${content}`,
          },
        },
      ],
    };
  });
};
