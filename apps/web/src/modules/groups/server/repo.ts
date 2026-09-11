import { and, asc, eq, getTableColumns, sql } from "drizzle-orm";
import { Cause, Context, Effect, Layer } from "effect";
import { uuidv7 } from "uuidv7";
import { GroupMemberNotFound, GroupNameTaken, GroupNotFound } from "../errors.ts";
import { Db } from "~/server/db.ts";
import { groupMembers, groups, user } from "~/db/schema/index.ts";

export type GroupRow = typeof groups.$inferSelect;
export type GroupWithCount = GroupRow & { memberCount: number };
export interface GroupMember {
  userId: string;
  name: string;
  email: string;
  role: string | null;
  canShare: boolean;
}
export interface Membership {
  userId: string;
  groupId: string;
  groupName: string;
}

// A unique-name conflict arrives as EffectDrizzleQueryError whose `cause` is
// a whole Effect Cause wrapping SqlError → effect/sql's tagged
// UniqueViolation. Squash the Cause to the underlying failure and walk from
// there instead of assuming exact nesting.
const isUniqueViolation = (error: unknown): boolean => {
  const outer = (error as { cause?: unknown }).cause;
  let current: unknown = Cause.isCause(outer) ? Cause.squash(outer) : outer;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    if ((current as { _tag?: unknown })._tag === "UniqueViolation") return true;
    const reason = (current as { reason?: { _tag?: unknown } }).reason;
    if (reason?._tag === "UniqueViolation") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
};

export class GroupRepo extends Context.Service<
  GroupRepo,
  {
    listGroups(): Effect.Effect<GroupWithCount[]>;
    createGroup(name: string): Effect.Effect<GroupRow, GroupNameTaken>;
    renameGroup(groupId: string, name: string): Effect.Effect<void, GroupNotFound | GroupNameTaken>;
    setMemberSharing(
      groupId: string,
      userId: string,
      canShare: boolean,
    ): Effect.Effect<void, GroupMemberNotFound>;
    /** Cascades memberships and model-access links. */
    deleteGroup(groupId: string): Effect.Effect<void>;
    getGroup(groupId: string): Effect.Effect<GroupRow, GroupNotFound>;
    listMembers(groupId: string): Effect.Effect<GroupMember[]>;
    /** Every membership with its group name — the users page's badges. */
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
          const rows = yield* db
            .insert(groups)
            .values({ id: uuidv7(), name })
            .returning()
            .pipe(
              Effect.catchTag("EffectDrizzleQueryError", (error) =>
                isUniqueViolation(error) ? new GroupNameTaken({ name }) : Effect.die(error),
              ),
            );
          return rows[0]!;
        }),

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
          function* (groupId, userId, canShare) {
            const rows = yield* db
              .update(groupMembers)
              .set({ canShare })
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
          return yield* db
            .select({
              userId: user.id,
              name: user.name,
              email: user.email,
              role: user.role,
              canShare: groupMembers.canShare,
            })
            .from(groupMembers)
            .innerJoin(user, eq(user.id, groupMembers.userId))
            .where(eq(groupMembers.groupId, groupId))
            .orderBy(asc(user.name))
            .pipe(Effect.orDie);
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
