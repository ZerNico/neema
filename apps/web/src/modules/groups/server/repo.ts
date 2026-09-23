import { and, asc, eq, getTableColumns, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { uuidv7 } from "uuidv7";
import { GroupMemberNotFound, GroupNameTaken, GroupNotFound } from "../errors.ts";
import { Db } from "~/server/db.ts";
import { defaultCapabilities, groupMembers, groups, user } from "~/db/schema/index.ts";
import { validCapabilities, type Capabilities } from "../policy.ts";
import { isUniqueViolation } from "~/server/sql.ts";

export type GroupRow = typeof groups.$inferSelect;
export type GroupWithCount = GroupRow & { memberCount: number };
/** Which of their own resources a member may share into the group. */
export interface MemberSharing {
  agents: boolean;
  knowledge: boolean;
  skills: boolean;
}
export interface GroupMember {
  userId: string;
  name: string;
  email: string;
  role: string | null;
  sharing: MemberSharing;
}
export interface Membership {
  userId: string;
  groupId: string;
  groupName: string;
}

/**
 * A unique-name conflict arrives as EffectDrizzleQueryError whose `cause` is
 * a whole Effect Cause wrapping SqlError → effect/sql's tagged
 */

export class GroupRepo extends Context.Service<
  GroupRepo,
  {
    listGroups(): Effect.Effect<GroupWithCount[]>;
    createGroup(name: string): Effect.Effect<GroupRow, GroupNameTaken>;
    getGroupCapabilities(groupId: string): Effect.Effect<Capabilities, GroupNotFound>;
    updateGroupCapabilities(
      groupId: string,
      capabilities: Capabilities,
    ): Effect.Effect<void, GroupNotFound>;
    getDefaultCapabilities(): Effect.Effect<Capabilities>;
    updateDefaultCapabilities(capabilities: Capabilities): Effect.Effect<void>;
    renameGroup(groupId: string, name: string): Effect.Effect<void, GroupNotFound | GroupNameTaken>;
    setMemberSharing(
      groupId: string,
      userId: string,
      sharing: MemberSharing,
    ): Effect.Effect<void, GroupMemberNotFound>;
    /** Cascades memberships and model-access links. */
    deleteGroup(groupId: string): Effect.Effect<void>;
    getGroup(groupId: string): Effect.Effect<GroupRow, GroupNotFound>;
    listMembers(groupId: string): Effect.Effect<GroupMember[]>;
    /** Every membership with its group name, for the users page's badges. */
    listMemberships(): Effect.Effect<Membership[]>;
    /** Idempotent: adding an existing member is a no-op. */
    addMember(groupId: string, userId: string): Effect.Effect<void>;
    removeMember(groupId: string, userId: string): Effect.Effect<void>;
  }
>()("chat/groups/GroupRepo") {
  static readonly layer = Layer.effect(
    GroupRepo,
    Effect.gen(function* () {
      const db = yield* Db;

      return GroupRepo.of({
        listGroups: Effect.fn("GroupRepo.listGroups")(function* () {
          const rows = yield* db
            .select({
              ...getTableColumns(groups),
              memberCount: sql<number>`count(${groupMembers.userId})::int`,
            })
            .from(groups)
            .leftJoin(groupMembers, eq(groupMembers.groupId, groups.id))
            .groupBy(groups.id)
            .orderBy(asc(groups.name))
            .pipe(Effect.orDie);
          return rows;
        }),

        createGroup: Effect.fn("GroupRepo.createGroup")(function* (name) {
          return yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                // SHARE locks serialize a create with default-policy updates. The
                // new group always starts with the default committed before it.
                const [defaults] = yield* tx
                  .select({ capabilities: defaultCapabilities.capabilities })
                  .from(defaultCapabilities)
                  .where(eq(defaultCapabilities.id, 1))
                  .for("share");
                if (!defaults) return yield* Effect.die(new Error("Default policy is missing"));
                const [row] = yield* tx
                  .insert(groups)
                  .values({ id: uuidv7(), name, capabilities: defaults.capabilities })
                  .returning();
                return row!;
              }),
            )
            .pipe(
              Effect.catch((error) =>
                isUniqueViolation(error) ? new GroupNameTaken({ name }) : Effect.die(error),
              ),
            );
        }),

        getGroupCapabilities: Effect.fn("GroupRepo.getGroupCapabilities")(function* (groupId) {
          const [row] = yield* db
            .select({ capabilities: groups.capabilities })
            .from(groups)
            .where(eq(groups.id, groupId))
            .pipe(Effect.orDie);
          if (!row) return yield* new GroupNotFound({ groupId });
          return row.capabilities;
        }),

        updateGroupCapabilities: Effect.fn("GroupRepo.updateGroupCapabilities")(
          function* (groupId, capabilities) {
            if (!validCapabilities(capabilities))
              return yield* Effect.die(new Response("Create requires Use", { status: 400 }));
            const rows = yield* db
              .update(groups)
              .set({ capabilities, updatedAt: new Date() })
              .where(eq(groups.id, groupId))
              .returning({ id: groups.id })
              .pipe(Effect.orDie);
            if (!rows.length) return yield* new GroupNotFound({ groupId });
          },
        ),

        getDefaultCapabilities: Effect.fn("GroupRepo.getDefaultCapabilities")(function* () {
          const [row] = yield* db
            .select({ capabilities: defaultCapabilities.capabilities })
            .from(defaultCapabilities)
            .where(eq(defaultCapabilities.id, 1))
            .pipe(Effect.orDie);
          if (!row) return yield* Effect.die(new Error("Default policy is missing"));
          return row.capabilities;
        }),

        updateDefaultCapabilities: Effect.fn("GroupRepo.updateDefaultCapabilities")(
          function* (capabilities) {
            if (!validCapabilities(capabilities))
              return yield* Effect.die(new Response("Create requires Use", { status: 400 }));
            const rows = yield* db
              .update(defaultCapabilities)
              .set({ capabilities })
              .where(eq(defaultCapabilities.id, 1))
              .returning({ id: defaultCapabilities.id })
              .pipe(Effect.orDie);
            if (!rows.length) return yield* Effect.die(new Error("Default policy is missing"));
          },
        ),

        renameGroup: Effect.fn("GroupRepo.renameGroup")(function* (groupId, name) {
          const rows = yield* db
            .update(groups)
            .set({ name, updatedAt: new Date() })
            .where(eq(groups.id, groupId))
            .returning({ id: groups.id })
            .pipe(
              Effect.catchTag("EffectDrizzleQueryError", (error) =>
                isUniqueViolation(error) ? new GroupNameTaken({ name }) : Effect.die(error),
              ),
            );
          if (rows.length === 0) return yield* new GroupNotFound({ groupId });
        }),

        setMemberSharing: Effect.fn("GroupRepo.setMemberSharing")(
          function* (groupId, userId, sharing) {
            const rows = yield* db
              .update(groupMembers)
              .set({
                shareAgents: sharing.agents,
                shareKnowledge: sharing.knowledge,
                shareSkills: sharing.skills,
              })
              .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)))
              .returning({ id: groupMembers.userId })
              .pipe(Effect.orDie);
            if (rows.length === 0) return yield* new GroupMemberNotFound({ groupId, userId });
          },
        ),

        deleteGroup: Effect.fn("GroupRepo.deleteGroup")(function* (groupId) {
          yield* db.delete(groups).where(eq(groups.id, groupId)).pipe(Effect.orDie);
        }),

        getGroup: Effect.fn("GroupRepo.getGroup")(function* (groupId) {
          const rows = yield* db
            .select()
            .from(groups)
            .where(eq(groups.id, groupId))
            .pipe(Effect.orDie);
          const row = rows[0];
          if (!row) return yield* new GroupNotFound({ groupId });
          return row;
        }),

        listMembers: Effect.fn("GroupRepo.listMembers")(function* (groupId) {
          const rows = yield* db
            .select({
              userId: user.id,
              name: user.name,
              email: user.email,
              role: user.role,
              agents: groupMembers.shareAgents,
              knowledge: groupMembers.shareKnowledge,
              skills: groupMembers.shareSkills,
            })
            .from(groupMembers)
            .innerJoin(user, eq(user.id, groupMembers.userId))
            .where(eq(groupMembers.groupId, groupId))
            .orderBy(asc(user.name))
            .pipe(Effect.orDie);
          return rows.map((row): GroupMember => ({
            userId: row.userId,
            name: row.name,
            email: row.email,
            role: row.role,
            sharing: { agents: row.agents, knowledge: row.knowledge, skills: row.skills },
          }));
        }),

        listMemberships: Effect.fn("GroupRepo.listMemberships")(function* () {
          return yield* db
            .select({
              userId: groupMembers.userId,
              groupId: groupMembers.groupId,
              groupName: groups.name,
            })
            .from(groupMembers)
            .innerJoin(groups, eq(groups.id, groupMembers.groupId))
            .orderBy(asc(groups.name))
            .pipe(Effect.orDie);
        }),

        addMember: Effect.fn("GroupRepo.addMember")(function* (groupId, userId) {
          yield* db
            .insert(groupMembers)
            .values({ groupId, userId })
            .onConflictDoNothing()
            .pipe(Effect.orDie);
        }),

        removeMember: Effect.fn("GroupRepo.removeMember")(function* (groupId, userId) {
          yield* db
            .delete(groupMembers)
            .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)))
            .pipe(Effect.orDie);
        }),
      });
    }),
  );
}
