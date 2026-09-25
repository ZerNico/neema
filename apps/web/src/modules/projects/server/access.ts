import { eq, sql, type SQL } from "drizzle-orm";
import { Effect } from "effect";
import { groupMembers, projectGroupGrants, projectMembers, projects } from "~/db/schema/index.ts";
import type { DbTx } from "~/modules/attachments/server/repo.ts";
import { capabilityAllowedSql } from "~/modules/groups/server/policy.ts";
import { ProjectNotAvailable } from "../errors.ts";
import type { ProjectRole, ResolvedProject } from "../schema.ts";

type Reader = Pick<DbTx, "select">;

/**
 * The person's role in the `projects` row in scope, or null when they have
 * none. A reader needs Use and the owner still needs Create: losing Create
 * suspends the project for everyone, the owner included, without deleting it.
 * Roles from a direct membership and from any group add up; the highest wins.
 */
export const projectRoleSql = (userId: string): SQL<ProjectRole | null> => {
  const granted = (role: "editor" | null) => sql`(
    exists (
      select 1 from ${projectMembers}
      where ${projectMembers.projectId} = ${projects.id}
        and ${projectMembers.userId} = ${userId}
        ${role ? sql`and ${projectMembers.role} = ${role}` : sql``}
    )
    or exists (
      select 1 from ${projectGroupGrants}
      join ${groupMembers} on ${groupMembers.groupId} = ${projectGroupGrants.groupId}
      where ${projectGroupGrants.projectId} = ${projects.id}
        and ${groupMembers.userId} = ${userId}
        ${role ? sql`and ${projectGroupGrants.role} = ${role}` : sql``}
    )
  )`;
  return sql<ProjectRole | null>`(case
    when not (${capabilityAllowedSql(userId, "projectsUse")})
      or not (${capabilityAllowedSql(projects.userId, "projectsCreate")}) then null
    when ${projects.userId} = ${userId} then 'owner'
    when ${granted("editor")} then 'editor'
    when ${granted(null)} then 'viewer'
  end)`;
};

/** The person's role in one project, or null. */
export const projectRole = (tx: Reader, userId: string, projectId: string) =>
  tx
    .select({ role: projectRoleSql(userId) })
    .from(projects)
    .where(eq(projects.id, projectId))
    .pipe(
      Effect.orDie,
      Effect.map(([row]) => row?.role ?? null),
    );

/**
 * What an attempt in a project chat runs with, read inside the attempt's
 * transaction like an agent. Losing access fails the turn rather than quietly
 * dropping the project's instructions.
 */
export const resolveProject = Effect.fn("projects.resolve")(function* (
  tx: Reader,
  userId: string,
  projectId: string,
) {
  const [row] = yield* tx
    .select({
      id: projects.id,
      name: projects.name,
      instructions: projects.instructions,
      role: projectRoleSql(userId),
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .pipe(Effect.orDie);
  if (!row?.role) return yield* new ProjectNotAvailable({ projectId });
  return { ...row, role: row.role } satisfies ResolvedProject;
});

/**
 * Everyone who may see a project's documents and memory: the owner, direct
 * members and members of granted groups. Used to fan out change hints only;
 * each reader's refetch is authorized on its own.
 */
export const projectAudience = (tx: Reader, projectId: string) =>
  Effect.gen(function* () {
    const [owner] = yield* tx
      .select({ userId: projects.userId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .pipe(Effect.orDie);
    if (!owner) return [];
    const direct = yield* tx
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(eq(projectMembers.projectId, projectId))
      .pipe(Effect.orDie);
    const grouped = yield* tx
      .select({ userId: groupMembers.userId })
      .from(projectGroupGrants)
      .innerJoin(groupMembers, eq(groupMembers.groupId, projectGroupGrants.groupId))
      .where(eq(projectGroupGrants.projectId, projectId))
      .pipe(Effect.orDie);
    return [...new Set([owner, ...direct, ...grouped].map((row) => row.userId))];
  });
