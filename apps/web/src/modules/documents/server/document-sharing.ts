import { randomBytes } from "node:crypto";
import { and, asc, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { Effect } from "effect";
import {
  documentGroupGrants,
  documentPublicLinks,
  documents,
  documentUserGrants,
  groupMembers,
  groups,
  user,
} from "~/db/schema/index.ts";
import { localized } from "~/i18n/localized.ts";
import {
  addressableByEmailSql,
  verificationRequiredIn,
} from "~/modules/auth/server/account-eligibility.ts";
import { capabilityAllowedSql } from "~/modules/groups/server/policy.ts";
import { m } from "~/paraglide/messages.js";
import type { DbTx } from "~/server/db.ts";
import {
  DOCUMENT_LIMITS,
  DocumentRejected,
  type DocumentShareChange,
  type DocumentSharing,
} from "../schema.ts";

type Reader = Pick<DbTx, "select">;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Everyone a person's document reaches: its owner, and each person and group member it is shared with. */
export const documentAudience = (tx: Reader, documentId: string) =>
  Effect.gen(function* () {
    const owner = yield* tx
      .select({ userId: documents.userId })
      .from(documents)
      .where(eq(documents.id, documentId))
      .pipe(Effect.orDie);
    const direct = yield* tx
      .select({ userId: documentUserGrants.userId })
      .from(documentUserGrants)
      .where(eq(documentUserGrants.documentId, documentId))
      .pipe(Effect.orDie);
    const grouped = yield* tx
      .select({ userId: groupMembers.userId })
      .from(documentGroupGrants)
      .innerJoin(groupMembers, eq(groupMembers.groupId, documentGroupGrants.groupId))
      .where(eq(documentGroupGrants.documentId, documentId))
      .pipe(Effect.orDie);
    return [
      ...new Set(
        [...owner, ...direct, ...grouped].flatMap((row) => (row.userId ? [row.userId] : [])),
      ),
    ];
  });

/**
 * Who a document is shared with. Only its owner learns which groups they may
 * add: the right to share with a group is the group's, not membership's.
 */
export const documentSharing = (tx: Reader, documentId: string, ownerId: string | null) =>
  Effect.gen(function* () {
    const users = yield* tx
      .select({
        userId: documentUserGrants.userId,
        name: user.name,
        email: user.email,
        role: documentUserGrants.role,
      })
      .from(documentUserGrants)
      .innerJoin(user, eq(user.id, documentUserGrants.userId))
      .where(eq(documentUserGrants.documentId, documentId))
      .orderBy(asc(user.name))
      .pipe(Effect.orDie);
    const granted = yield* tx
      .select({ groupId: groups.id, name: groups.name, role: documentGroupGrants.role })
      .from(documentGroupGrants)
      .innerJoin(groups, eq(groups.id, documentGroupGrants.groupId))
      .where(eq(documentGroupGrants.documentId, documentId))
      .orderBy(asc(groups.name))
      .pipe(Effect.orDie);
    const [owner] = yield* tx
      .select({ name: user.name, role: user.role })
      .from(documents)
      .innerJoin(user, eq(user.id, documents.userId))
      .where(eq(documents.id, documentId))
      .pipe(Effect.orDie);
    const eligibleGroups = ownerId
      ? yield* tx
          .select({ id: groups.id, name: groups.name })
          .from(groups)
          .where(
            owner?.role === "admin"
              ? undefined
              : sql`exists(select 1 from ${groupMembers} where ${groupMembers.groupId} = ${groups.id} and ${groupMembers.userId} = ${ownerId} and ${groupMembers.shareProjects})`,
          )
          .orderBy(asc(groups.name))
          .limit(200)
          .pipe(Effect.orDie)
      : [];
    const publicLink = ownerId
      ? yield* tx
          .select({
            token: sql<
              string | null
            >`(select ${documentPublicLinks.token} from ${documentPublicLinks} where ${documentPublicLinks.documentId} = ${documentId})`,
            canPublish: capabilityAllowedSql(ownerId, "publicLinks"),
          })
          .from(user)
          .where(eq(user.id, ownerId))
          .pipe(
            Effect.orDie,
            Effect.map(([row]) => ({
              token: row?.token ?? null,
              canPublish: row?.canPublish === true,
            })),
          )
      : null;
    return {
      ownerName: owner?.name ?? "",
      users,
      groups: granted,
      eligibleGroups,
      publicLink,
    } satisfies DocumentSharing;
  });

const refuse = (reason: () => string) =>
  Effect.fail(new DocumentRejected({ reason: localized(reason) }));

/**
 * One change to who a person's document is shared with, by its owner, who
 * holds the document's lock. Answers who gained or lost it, to hear of it.
 */
export const changeDocumentSharing = (
  tx: DbTx,
  ownerId: string,
  documentId: string,
  change: DocumentShareChange,
) =>
  Effect.gen(function* () {
    switch (change.action) {
      case "addUser": {
        const email = change.email.trim().toLowerCase();
        if (!EMAIL.test(email)) return yield* refuse(m.documents_share_error_add_failed);
        const required = yield* verificationRequiredIn(tx);
        const [recipient] = yield* tx
          .select({ id: user.id })
          .from(user)
          .where(and(eq(user.email, email), addressableByEmailSql(required)))
          .for("key share")
          .pipe(Effect.orDie);
        if (!recipient || recipient.id === ownerId)
          return yield* refuse(m.documents_share_error_add_failed);
        const [count] = yield* tx
          .select({ value: sql<number>`count(*)::int` })
          .from(documentUserGrants)
          .where(
            and(
              eq(documentUserGrants.documentId, documentId),
              ne(documentUserGrants.userId, recipient.id),
            ),
          )
          .pipe(Effect.orDie);
        if ((count?.value ?? 0) >= DOCUMENT_LIMITS.shares)
          return yield* refuse(m.documents_share_error_full);
        yield* tx
          .insert(documentUserGrants)
          .values({ documentId, userId: recipient.id, role: change.role })
          .onConflictDoUpdate({
            target: [documentUserGrants.documentId, documentUserGrants.userId],
            set: { role: change.role },
          })
          .pipe(Effect.orDie);
        return [recipient.id];
      }
      case "setUserRole": {
        const rows = yield* tx
          .update(documentUserGrants)
          .set({ role: change.role })
          .where(
            and(
              eq(documentUserGrants.documentId, documentId),
              eq(documentUserGrants.userId, change.userId),
            ),
          )
          .returning({ userId: documentUserGrants.userId })
          .pipe(Effect.orDie);
        if (!rows.length) return yield* refuse(m.documents_share_error_not_shared);
        return [change.userId];
      }
      case "removeUser":
        yield* tx
          .delete(documentUserGrants)
          .where(
            and(
              eq(documentUserGrants.documentId, documentId),
              eq(documentUserGrants.userId, change.userId),
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
        if (!group) return yield* refuse(m.documents_share_error_group_unavailable);
        const [actor] = yield* tx
          .select({ role: user.role })
          .from(user)
          .where(eq(user.id, ownerId))
          .pipe(Effect.orDie);
        if (actor?.role !== "admin") {
          // Held through the insert, so revoking the right serializes with this grant.
          const [member] = yield* tx
            .select({ canShare: groupMembers.shareProjects })
            .from(groupMembers)
            .where(and(eq(groupMembers.groupId, change.groupId), eq(groupMembers.userId, ownerId)))
            .for("share")
            .pipe(Effect.orDie);
          if (!member?.canShare) return yield* refuse(m.documents_share_error_group_unavailable);
        }
        const [count] = yield* tx
          .select({ value: sql<number>`count(*)::int` })
          .from(documentGroupGrants)
          .where(
            and(
              eq(documentGroupGrants.documentId, documentId),
              ne(documentGroupGrants.groupId, change.groupId),
            ),
          )
          .pipe(Effect.orDie);
        if ((count?.value ?? 0) >= DOCUMENT_LIMITS.shares)
          return yield* refuse(m.documents_share_error_full);
        yield* tx
          .insert(documentGroupGrants)
          .values({ documentId, groupId: change.groupId, role: change.role })
          .onConflictDoUpdate({
            target: [documentGroupGrants.documentId, documentGroupGrants.groupId],
            set: { role: change.role },
          })
          .pipe(Effect.orDie);
        const joined = yield* tx
          .select({ userId: groupMembers.userId })
          .from(groupMembers)
          .where(eq(groupMembers.groupId, change.groupId))
          .pipe(Effect.orDie);
        return joined.map((row) => row.userId);
      }
      case "removeGroup": {
        // Those losing access still need to hear about it.
        const losing = yield* tx
          .select({ userId: groupMembers.userId })
          .from(groupMembers)
          .where(eq(groupMembers.groupId, change.groupId))
          .pipe(Effect.orDie);
        yield* tx
          .delete(documentGroupGrants)
          .where(
            and(
              eq(documentGroupGrants.documentId, documentId),
              eq(documentGroupGrants.groupId, change.groupId),
            ),
          )
          .pipe(Effect.orDie);
        return losing.map((row) => row.userId);
      }
      case "setPublicLink": {
        if (!change.enabled) {
          yield* tx
            .delete(documentPublicLinks)
            .where(eq(documentPublicLinks.documentId, documentId))
            .pipe(Effect.orDie);
          return [];
        }
        const [allowed] = yield* tx
          .select({ value: capabilityAllowedSql(ownerId, "publicLinks") })
          .from(user)
          .where(eq(user.id, ownerId))
          .pipe(Effect.orDie);
        if (!allowed?.value) return yield* refuse(m.documents_public_link_error_not_allowed);
        yield* tx
          .insert(documentPublicLinks)
          .values({ documentId, token: randomBytes(24).toString("base64url") })
          .onConflictDoNothing()
          .pipe(Effect.orDie);
        return [];
      }
    }
  });

/**
 * The document a public link opens and the owner it is read as, while the
 * link stands: the document is still a person's and kept, and its owner may
 * still use documents and publish, with an account still in use.
 */
export const publicLinkTarget = (tx: Reader, token: string) =>
  tx
    .select({ documentId: documents.id, ownerId: sql<string>`${documents.userId}` })
    .from(documentPublicLinks)
    .innerJoin(documents, eq(documents.id, documentPublicLinks.documentId))
    .where(
      and(
        eq(documentPublicLinks.token, token),
        isNotNull(documents.userId),
        isNull(documents.projectId),
        capabilityAllowedSql(documents.userId, "documents"),
        capabilityAllowedSql(documents.userId, "publicLinks"),
      ),
    )
    .pipe(
      Effect.orDie,
      Effect.map(([row]) => row ?? null),
    );
