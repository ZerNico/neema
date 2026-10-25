import { localized } from "~/i18n/localized.ts";
import { m } from "~/paraglide/messages.js";
import { eq, sql, type SQL } from "drizzle-orm";
import { Effect } from "effect";
import { groupMembers, projectGroupGrants, projectMembers, projects } from "~/db/schema/index.ts";
import { capabilityAllowedSql } from "~/modules/groups/server/policy.ts";
import { ProjectNotAvailable, ProjectRejected } from "../errors.ts";
import { projectCan, type ProjectRole, type ResolvedProject } from "../schema.ts";
import type { SyncBus } from "~/modules/sync/server/bus.ts";
import type { DbTx } from "~/server/db.ts";

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
 * The person's role in a project, failing when they have none. `lock` holds
 * the project row for the rest of the transaction: `update` where the write
 * counts or orders the project's contents, `share` where the project only
 * must not be deleted meanwhile.
 */
export const projectAccess = Effect.fn("projects.access")(function* (
  tx: Pick<DbTx, "select">,
  userId: string,
  projectId: string,
  lock?: "update" | "share",
) {
  const query = tx
    .select({ role: projectRoleSql(userId) })
    .from(projects)
    .where(eq(projects.id, projectId));
  const [row] = yield* (lock ? query.for(lock) : query).pipe(Effect.orDie);
  if (!row?.role) return yield* new ProjectNotAvailable({ projectId });
  return row.role;
});

/** Like `projectAccess`, and refuses a role that may not edit, or manage, the project. */
export const requireProject = Effect.fn("projects.require")(function* (
  tx: Pick<DbTx, "select">,
  userId: string,
  projectId: string,
  need: "edit" | "manage",
  lock?: "update" | "share",
) {
  const role = yield* projectAccess(tx, userId, projectId, lock);
  if (!projectCan[need](role))
    return yield* new ProjectRejected({
      reason:
        need === "edit"
          ? localized(m.projects_error_read_only)
          : localized(m.projects_error_owner_only),
    });
  return role;
});

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

/** Tells everyone in a project, and `alsoTo`, that it changed; each refetch is authorized alone. */
export const projectNotifier =
  (db: Reader, bus: SyncBus["Service"]) =>
  (projectId: string, alsoTo: ReadonlyArray<string> = []) =>
    projectAudience(db, projectId).pipe(
      Effect.flatMap((members) =>
        Effect.forEach(
          [...new Set([...members, ...alsoTo])],
          (memberId) => bus.publish(memberId, { type: "project.changed", projectId }),
          { discard: true },
        ),
      ),
      Effect.catchCause(() => Effect.logWarning("project invalidation failed")),
    );
