import { activeAccountSql } from "~/modules/auth/server/account-eligibility.ts";
import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { uuidv7 } from "uuidv7";
import {
  conversations,
  groupMembers,
  groups,
  projectFiles,
  projectFileVersions,
  projectGroupGrants,
  projectMembers,
  projects,
  user,
} from "~/db/schema/index.ts";
import {
  ownedConversation,
  ownedConversationById,
} from "~/modules/chat/server/owned-conversation.ts";
import { collectOrphanedBlobs, lockBlobs } from "~/modules/attachments/server/blob-references.ts";
import type { DbTx } from "~/modules/attachments/server/repo.ts";
import { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { Db } from "~/server/db.ts";
import { ProjectNotAvailable, ProjectRejected } from "../errors.ts";
import {
  PROJECT_LIMITS,
  projectCan,
  type CreateProjectInput,
  type ProjectChat,
  type ProjectDetail,
  type ProjectMemberRole,
  type ProjectMembers,
  type ProjectRole,
  type ProjectSummary,
  type UpdateProjectInput,
} from "../schema.ts";
import { projectAudience, projectRole, projectRoleSql } from "./access.ts";

type ProjectError = ProjectNotAvailable | ProjectRejected;
type MemberChange =
  | { action: "addUser"; email: string; role: ProjectMemberRole }
  | { action: "setUserRole"; userId: string; role: ProjectMemberRole }
  | { action: "removeUser"; userId: string }
  | { action: "addGroup"; groupId: string; role: ProjectMemberRole }
  | { action: "removeGroup"; groupId: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const summaryColumns = (userId: string) => ({
  id: projects.id,
  name: projects.name,
  description: projects.description,
  instructions: projects.instructions,
  ownerId: projects.userId,
  ownerName: user.name,
  createdAt: projects.createdAt,
  updatedAt: projects.updatedAt,
  role: projectRoleSql(userId),
});
const detailOf = (row: {
  id: string;
  name: string;
  description: string;
  instructions: string;
  ownerId: string;
  ownerName: string;
  createdAt: Date;
  updatedAt: Date;
  role: ProjectRole;
}): ProjectDetail => ({
  ...row,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});
/** Fails unless the person holds at least this much of the project. */
const requireRole = (
  tx: DbTx,
  userId: string,
  projectId: string,
  allowed: (role: ProjectRole | null) => boolean,
) =>
  Effect.gen(function* () {
    const role = yield* projectRole(tx, userId, projectId);
    if (!role) return yield* new ProjectNotAvailable({ projectId });
    if (!allowed(role))
      return yield* new ProjectRejected({
        reason: "your role in this project does not allow that",
      });
    return role;
  });

export class ProjectService extends Context.Service<
  ProjectService,
  {
    list(userId: string): Effect.Effect<ReadonlyArray<ProjectSummary>>;
    get(userId: string, projectId: string): Effect.Effect<ProjectDetail, ProjectNotAvailable>;
    create(userId: string, input: CreateProjectInput): Effect.Effect<ProjectDetail, ProjectError>;
    update(userId: string, input: UpdateProjectInput): Effect.Effect<ProjectDetail, ProjectError>;
    remove(userId: string, projectId: string): Effect.Effect<void, ProjectError>;
    members(userId: string, projectId: string): Effect.Effect<ProjectMembers, ProjectNotAvailable>;
    /** Owners manage everyone; any member may remove themselves, which is leaving. */
    changeMembers(
      userId: string,
      projectId: string,
      change: MemberChange,
    ): Effect.Effect<void, ProjectError>;
    /** The person's own chats in the project; nobody else's are ever listed. */
    chats(
      userId: string,
      projectId: string,
    ): Effect.Effect<ReadonlyArray<ProjectChat>, ProjectNotAvailable>;
    /** Moves one of the person's chats into a project, or out with null. */
    move(
      userId: string,
      conversationId: string,
      projectId: string | null,
    ): Effect.Effect<void, ProjectError>;
    /** Every member's id, for change hints. */
    audience(projectId: string, tx?: DbTx): Effect.Effect<ReadonlyArray<string>>;
  }
>()("chat/projects/ProjectService") {
  static readonly layer = Layer.effect(
    ProjectService,
    Effect.gen(function* () {
      const db = yield* Db;
      const policy = yield* FeaturePolicy;
      const bus = yield* SyncBus;
      const transaction = <A, E, R>(body: (tx: DbTx) => Effect.Effect<A, E, R>) =>
        db.transaction(body).pipe(Effect.catchTag("SqlError", Effect.die));

      const read = (userId: string, projectId: string, tx?: DbTx) =>
        Effect.gen(function* () {
          const [row] = yield* (tx ?? db)
            .select(summaryColumns(userId))
            .from(projects)
            .innerJoin(user, eq(user.id, projects.userId))
            .where(eq(projects.id, projectId))
            .pipe(Effect.orDie);
          if (!row?.role) return yield* new ProjectNotAvailable({ projectId });
          return detailOf({ ...row, role: row.role });
        });
      const audience = (projectId: string, tx?: DbTx) => projectAudience(tx ?? db, projectId);
      /** Hints to everyone who was or is a member, so a removal reaches the removed. */
      const changed = (projectId: string, alsoTo: ReadonlyArray<string> = []) =>
        audience(projectId).pipe(
          Effect.flatMap((members) =>
            Effect.forEach(
              [...new Set([...members, ...alsoTo])],
              (memberId) => bus.publish(memberId, { type: "project.changed", projectId }),
              { discard: true },
            ),
          ),
          Effect.catchCause(() => Effect.logWarning("project invalidation failed")),
        );

      const list = Effect.fn("ProjectService.list")(function* (userId: string) {
        const role = projectRoleSql(userId);
        const rows = yield* db
          .select(summaryColumns(userId))
          .from(projects)
          .innerJoin(user, eq(user.id, projects.userId))
          .where(isNotNull(role))
          .orderBy(desc(projects.updatedAt), desc(projects.id))
          .pipe(Effect.orDie);
        return rows.map(({ instructions: _, ownerId: __, createdAt: ___, ...row }) => ({
          ...row,
          role: row.role!,
          updatedAt: row.updatedAt.toISOString(),
        }));
      });

      const create = Effect.fn("ProjectService.create")(function* (
        userId: string,
        input: CreateProjectInput,
      ) {
        if (!(yield* policy.can(userId, "projectsCreate")))
          return yield* new ProjectRejected({ reason: "creating projects is not permitted" });
        const id = uuidv7();
        yield* db
          .insert(projects)
          .values({
            id,
            userId,
            name: input.name.trim(),
            description: input.description?.trim() ?? "",
            instructions: input.instructions ?? "",
          })
          .pipe(Effect.orDie);
        yield* changed(id);
        return yield* read(userId, id);
      });

      const update = Effect.fn("ProjectService.update")(function* (
        userId: string,
        input: UpdateProjectInput,
      ) {
        yield* transaction((tx) =>
          Effect.gen(function* () {
            yield* requireRole(tx, userId, input.projectId, projectCan.edit);
            yield* tx
              .update(projects)
              .set({
                ...(input.name !== undefined ? { name: input.name.trim() } : {}),
                ...(input.description !== undefined
                  ? { description: input.description.trim() }
                  : {}),
                ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
                updatedAt: new Date(),
              })
              .where(eq(projects.id, input.projectId))
              .pipe(Effect.orDie);
          }),
        );
        yield* changed(input.projectId);
        return yield* read(userId, input.projectId);
      });

      const remove = Effect.fn("ProjectService.remove")(function* (
        userId: string,
        projectId: string,
      ) {
        const members = yield* audience(projectId);
        const moved = yield* transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .select({ id: user.id })
              .from(user)
              .where(eq(user.id, userId))
              .for("no key update")
              .pipe(Effect.orDie);
            if ((yield* projectRole(tx, userId, projectId)) !== "owner") return null;
            yield* tx
              .select({ id: conversations.id })
              .from(conversations)
              .where(eq(conversations.projectId, projectId))
              .orderBy(asc(conversations.id))
              .for("update")
              .pipe(Effect.orDie);
            yield* tx
              .select({ id: projects.id })
              .from(projects)
              .where(eq(projects.id, projectId))
              .for("update")
              .pipe(Effect.orDie);
            if ((yield* projectRole(tx, userId, projectId)) !== "owner") return null;
            // The project lock blocks new FK attachments. A chat attached while we
            // waited may hold its own lock and wait on this project: retry, never wait backwards.
            const attached = yield* tx
              .select({ id: conversations.id })
              .from(conversations)
              .where(eq(conversations.projectId, projectId))
              .pipe(Effect.orDie);
            const chats = yield* tx
              .select({ id: conversations.id, userId: conversations.userId })
              .from(conversations)
              .where(eq(conversations.projectId, projectId))
              .orderBy(asc(conversations.id))
              .for("update", { skipLocked: true })
              .pipe(Effect.orDie);
            if (chats.length !== attached.length)
              return yield* Effect.fail({ _tag: "ProjectDeleteBusy" as const });
            // Its files' bytes are left to the cleanup ledger: the orphan check
            // records them in this transaction, and the reconciler deletes them.
            const blobIds = (yield* tx
              .select({ blobId: projectFileVersions.blobId })
              .from(projectFileVersions)
              .innerJoin(projectFiles, eq(projectFiles.id, projectFileVersions.fileId))
              .where(eq(projectFiles.projectId, projectId))
              .pipe(Effect.orDie)).map((row) => row.blobId);
            yield* lockBlobs(tx, blobIds).pipe(Effect.orDie);
            // Chats come out as ordinary chats; documents, memory and files go with it.
            yield* tx.delete(projects).where(eq(projects.id, projectId)).pipe(Effect.orDie);
            yield* collectOrphanedBlobs(tx, blobIds).pipe(Effect.orDie);
            return chats;
          }),
        ).pipe(
          Effect.retry({ times: 4, while: (error) => error._tag === "ProjectDeleteBusy" }),
          Effect.catchTag("ProjectDeleteBusy", () =>
            Effect.fail(
              new ProjectRejected({ reason: "the project changed; try deleting it again" }),
            ),
          ),
        );
        if (!moved) return yield* new ProjectNotAvailable({ projectId });
        yield* Effect.forEach(
          [
            ...members.map((memberId) => ({
              memberId,
              event: { type: "project.changed" as const, projectId },
            })),
            ...moved.map((chat) => ({
              memberId: chat.userId,
              event: { type: "conversation.updated" as const, conversationId: chat.id },
            })),
          ],
          ({ memberId, event }) =>
            bus.publish(memberId, event).pipe(Effect.catchCause(() => Effect.void)),
          { discard: true },
        );
      });

      const members = Effect.fn("ProjectService.members")(function* (
        userId: string,
        projectId: string,
      ) {
        const role = yield* projectRole(db, userId, projectId);
        if (!role) return yield* new ProjectNotAvailable({ projectId });
        const users = yield* db
          .select({
            userId: projectMembers.userId,
            name: user.name,
            email: user.email,
            role: projectMembers.role,
          })
          .from(projectMembers)
          .innerJoin(user, eq(user.id, projectMembers.userId))
          .where(eq(projectMembers.projectId, projectId))
          .orderBy(asc(user.name))
          .pipe(Effect.orDie);
        const granted = yield* db
          .select({ groupId: groups.id, name: groups.name, role: projectGroupGrants.role })
          .from(projectGroupGrants)
          .innerJoin(groups, eq(groups.id, projectGroupGrants.groupId))
          .where(eq(projectGroupGrants.projectId, projectId))
          .orderBy(asc(groups.name))
          .pipe(Effect.orDie);
        if (role !== "owner") return { users, groups: granted, eligibleGroups: [] };
        const [actor] = yield* db
          .select({ role: user.role })
          .from(user)
          .where(eq(user.id, userId))
          .pipe(Effect.orDie);
        // Membership alone never allows granting a project to a group.
        const eligibleGroups = yield* db
          .select({ id: groups.id, name: groups.name })
          .from(groups)
          .where(
            actor?.role === "admin"
              ? undefined
              : sql`exists(select 1 from ${groupMembers} where ${groupMembers.groupId} = ${groups.id} and ${groupMembers.userId} = ${userId} and ${groupMembers.shareProjects})`,
          )
          .orderBy(asc(groups.name))
          .limit(200)
          .pipe(Effect.orDie);
        return { users, groups: granted, eligibleGroups };
      });

      const changeMembers = Effect.fn("ProjectService.changeMembers")(function* (
        userId: string,
        projectId: string,
        change: MemberChange,
      ) {
        const leaving = change.action === "removeUser" && change.userId === userId;
        const affected = yield* transaction((tx) =>
          Effect.gen(function* () {
            // The row lock serializes membership changes with each other and with delete.
            const [locked] = yield* tx
              .select({ id: projects.id })
              .from(projects)
              .where(eq(projects.id, projectId))
              .for("update")
              .pipe(Effect.orDie);
            if (!locked) return yield* new ProjectNotAvailable({ projectId });
            const role = yield* requireRole(tx, userId, projectId, (current) =>
              leaving ? current !== "owner" : projectCan.manage(current),
            );
            if (role === "owner" && !(yield* policy.can(userId, "projectsCreate", tx)))
              return yield* new ProjectNotAvailable({ projectId });
            switch (change.action) {
              case "addUser": {
                const email = change.email.trim().toLowerCase();
                if (!EMAIL.test(email))
                  return yield* new ProjectRejected({
                    reason: "enter an existing account's email address",
                  });
                const [recipient] = yield* tx
                  .select({ id: user.id })
                  .from(user)
                  .where(and(eq(user.email, email), activeAccountSql))
                  .for("key share")
                  .pipe(Effect.orDie);
                if (!recipient || recipient.id === userId)
                  return yield* new ProjectRejected({ reason: "could not add that account" });
                const [count] = yield* tx
                  .select({ value: sql<number>`count(*)::int` })
                  .from(projectMembers)
                  .where(eq(projectMembers.projectId, projectId))
                  .pipe(Effect.orDie);
                if ((count?.value ?? 0) >= PROJECT_LIMITS.members)
                  return yield* new ProjectRejected({
                    reason: "this project has as many members as it can",
                  });
                yield* tx
                  .insert(projectMembers)
                  .values({ projectId, userId: recipient.id, role: change.role })
                  .onConflictDoUpdate({
                    target: [projectMembers.projectId, projectMembers.userId],
                    set: { role: change.role },
                  })
                  .pipe(Effect.orDie);
                return [recipient.id];
              }
              case "setUserRole": {
                const rows = yield* tx
                  .update(projectMembers)
                  .set({ role: change.role })
                  .where(
                    and(
                      eq(projectMembers.projectId, projectId),
                      eq(projectMembers.userId, change.userId),
                    ),
                  )
                  .returning({ userId: projectMembers.userId })
                  .pipe(Effect.orDie);
                if (!rows.length)
                  return yield* new ProjectRejected({ reason: "that person is not a member" });
                return [change.userId];
              }
              case "removeUser":
                yield* tx
                  .delete(projectMembers)
                  .where(
                    and(
                      eq(projectMembers.projectId, projectId),
                      eq(projectMembers.userId, change.userId),
                    ),
                  )
                  .pipe(Effect.orDie);
                return [change.userId];
              case "addGroup": {
                const [group] = yield* tx
                  .select({ id: groups.id })
                  .from(groups)
                  .where(eq(groups.id, change.groupId))
                  .for("share")
                  .pipe(Effect.orDie);
                if (!group)
                  return yield* new ProjectRejected({ reason: "that group is not available" });
                const [actor] = yield* tx
                  .select({ role: user.role })
                  .from(user)
                  .where(eq(user.id, userId))
                  .pipe(Effect.orDie);
                if (actor?.role !== "admin") {
                  // Held through the insert, so revoking the right serializes with this grant.
                  const [member] = yield* tx
                    .select({ canShare: groupMembers.shareProjects })
                    .from(groupMembers)
                    .where(
                      and(
                        eq(groupMembers.groupId, change.groupId),
                        eq(groupMembers.userId, userId),
                      ),
                    )
                    .for("share")
                    .pipe(Effect.orDie);
                  if (!member?.canShare)
                    return yield* new ProjectRejected({ reason: "that group is not available" });
                }
                yield* tx
                  .insert(projectGroupGrants)
                  .values({ projectId, groupId: change.groupId, role: change.role })
                  .onConflictDoUpdate({
                    target: [projectGroupGrants.projectId, projectGroupGrants.groupId],
                    set: { role: change.role },
                  })
                  .pipe(Effect.orDie);
                return [];
              }
              case "removeGroup": {
                // Those losing access still need to hear about it.
                const losing = yield* tx
                  .select({ userId: groupMembers.userId })
                  .from(groupMembers)
                  .where(eq(groupMembers.groupId, change.groupId))
                  .pipe(Effect.orDie);
                yield* tx
                  .delete(projectGroupGrants)
                  .where(
                    and(
                      eq(projectGroupGrants.projectId, projectId),
                      eq(projectGroupGrants.groupId, change.groupId),
                    ),
                  )
                  .pipe(Effect.orDie);
                return losing.map((member) => member.userId);
              }
            }
          }),
        );
        yield* changed(projectId, affected);
      });

      const chats = Effect.fn("ProjectService.chats")(function* (
        userId: string,
        projectId: string,
      ) {
        if (!(yield* projectRole(db, userId, projectId)))
          return yield* new ProjectNotAvailable({ projectId });
        const activity = sql<Date>`coalesce(${conversations.lastMessageAt}, ${conversations.createdAt})`;
        const rows = yield* db
          .select({ id: conversations.id, title: conversations.title, lastActivityAt: activity })
          .from(conversations)
          .where(
            and(
              eq(conversations.projectId, projectId),
              ownedConversation(userId),
              // Archived chats leave every list, a project's too.
              isNull(conversations.archivedAt),
            ),
          )
          .orderBy(desc(activity), desc(conversations.id))
          .limit(200)
          .pipe(Effect.orDie);
        return rows.map((row) => ({
          ...row,
          lastActivityAt: new Date(row.lastActivityAt).toISOString(),
        }));
      });

      const move = Effect.fn("ProjectService.move")(function* (
        userId: string,
        conversationId: string,
        projectId: string | null,
      ) {
        const previous = yield* transaction((tx) =>
          Effect.gen(function* () {
            // The same lock a send takes, so a move never lands halfway through an attempt's read.
            const [conversation] = yield* tx
              .select({ projectId: conversations.projectId, temporary: conversations.temporary })
              .from(conversations)
              .where(ownedConversationById(conversationId, userId))
              .for("update")
              .pipe(Effect.orDie);
            if (!conversation)
              return yield* new ProjectRejected({ reason: "that chat is not available" });
            if (conversation.temporary)
              return yield* new ProjectRejected({
                reason: "a temporary chat cannot join a project",
              });
            if (projectId && !(yield* projectRole(tx, userId, projectId)))
              return yield* new ProjectNotAvailable({ projectId });
            yield* tx
              .update(conversations)
              .set({ projectId, updatedAt: new Date() })
              .where(eq(conversations.id, conversationId))
              .pipe(Effect.orDie);
            return conversation.projectId;
          }),
        );
        yield* bus
          .publish(userId, { type: "conversation.updated", conversationId })
          .pipe(Effect.catchCause(() => Effect.void));
        for (const id of new Set([previous, projectId]))
          if (id)
            yield* bus
              .publish(userId, { type: "project.changed", projectId: id })
              .pipe(Effect.catchCause(() => Effect.void));
      });

      return ProjectService.of({
        list,
        get: (userId, projectId) => read(userId, projectId),
        create,
        update,
        remove,
        members,
        changeMembers,
        chats,
        move,
        audience,
      });
    }),
  );
}
