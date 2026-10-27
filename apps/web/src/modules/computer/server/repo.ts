import type { PermissionLevel } from "~/modules/chat/schema.ts";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import type { DestinationGrant, MachineHello } from "@chat/desktop-rpc";
import {
  attachments,
  conversations,
  machines,
  messageAttachments,
  messages,
  networkGrants,
} from "~/db/schema/index.ts";
import { ownedConversationById } from "~/modules/chat/server/owned-conversation.ts";
import { Db } from "~/server/db.ts";

/** What the server knows about a chat's computer. */
export interface ChatComputer {
  readonly conversationId: string;
  readonly machineId: string | null;
  readonly folders: ReadonlyArray<{ name: string; readOnly: boolean }>;
  readonly permissionLevel: PermissionLevel;
}

export interface MachineRecord {
  readonly id: string;
  readonly name: string;
  readonly platform: "darwin" | "win32" | "linux";
  readonly lastSeenAt: Date;
}

const toMachine = (row: typeof machines.$inferSelect): MachineRecord => ({
  id: row.id,
  name: row.label ?? row.name,
  platform: row.platform,
  lastSeenAt: row.lastSeenAt,
});
const updated = (rows: readonly unknown[]) => rows.length > 0;

export class ComputerRepo extends Context.Service<
  ComputerRepo,
  {
    /** Records a machine connecting, its name and platform as it reports them now. */
    /** Records a connecting machine; the name to show for it, the person's own when they set one. */
    saveMachine(userId: string, hello: MachineHello): Effect.Effect<string>;
    /** The person's name for a machine, or null for the one it reports; null when not theirs. */
    renameMachine(
      userId: string,
      machineId: string,
      label: string | null,
    ): Effect.Effect<string | null>;
    touchMachine(userId: string, machineId: string): Effect.Effect<void>;
    machine(userId: string, machineId: string): Effect.Effect<MachineRecord | null>;
    machines(userId: string): Effect.Effect<ReadonlyArray<MachineRecord>>;
    forgetMachine(userId: string, machineId: string): Effect.Effect<void>;
    chat(userId: string, conversationId: string): Effect.Effect<ChatComputer | null>;
    /**
     * Which of these chats no longer exist for anyone. A machine may hold chats of another
     * account that signed in on it, and those must not look gone.
     */
    gone(conversationIds: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<string>>;
    /** Binds an unbound chat; false when it already has a machine or is not the person's. */
    bind(userId: string, conversationId: string, machineId: string): Effect.Effect<boolean>;
    /** Points the chat at another machine; its folders belong to the old one and go. */
    rebind(
      userId: string,
      conversationId: string,
      machineId: string | null,
    ): Effect.Effect<boolean>;
    /**
     * The chat's folder names as its machine reports them. Folders attached at a machine are a
     * use of it, so a chat with no computer yet binds to that machine.
     */
    setFolders(
      userId: string,
      machineId: string,
      conversationId: string,
      folders: ReadonlyArray<{ name: string; readOnly: boolean }>,
    ): Effect.Effect<boolean>;
    setPermissionLevel(
      userId: string,
      conversationId: string,
      level: PermissionLevel,
    ): Effect.Effect<boolean>;
    grants(userId: string): Effect.Effect<ReadonlyArray<DestinationGrant>>;
    addGrant(
      userId: string,
      grant: { conversationId: string | null; host: string; port: number; privateNetwork: boolean },
    ): Effect.Effect<void>;
    removeGrant(userId: string, grantId: string): Effect.Effect<boolean>;
    /** Whether a stored file is one of this chat's own: sent in it, or made by an answer in it. */
    holdsAttachment(
      userId: string,
      conversationId: string,
      attachmentId: string,
    ): Effect.Effect<boolean>;
    /** Files the person sent in the chat, oldest first, by their own names. */
    sentFiles(
      userId: string,
      conversationId: string,
    ): Effect.Effect<ReadonlyArray<{ id: string; name: string }>>;
  }
>()("chat/computer/ComputerRepo") {
  static readonly layer = Layer.effect(
    ComputerRepo,
    Effect.gen(function* () {
      const db = yield* Db;
      return ComputerRepo.of({
        saveMachine: (userId, hello) =>
          db
            .insert(machines)
            .values({ id: hello.machineId, userId, name: hello.name, platform: hello.platform })
            .onConflictDoUpdate({
              target: [machines.userId, machines.id],
              set: { name: hello.name, platform: hello.platform, lastSeenAt: sql`now()` },
            })
            .returning({ name: machines.name, label: machines.label })
            .pipe(
              Effect.orDie,
              Effect.map(([row]) => row?.label ?? row?.name ?? hello.name),
            ),
        renameMachine: (userId, machineId, label) =>
          db
            .update(machines)
            .set({ label })
            .where(and(eq(machines.userId, userId), eq(machines.id, machineId)))
            .returning({ name: machines.name, label: machines.label })
            .pipe(
              Effect.orDie,
              Effect.map(([row]) => (row ? (row.label ?? row.name) : null)),
            ),
        touchMachine: (userId, machineId) =>
          db
            .update(machines)
            .set({ lastSeenAt: sql`now()` })
            .where(and(eq(machines.userId, userId), eq(machines.id, machineId)))
            .pipe(Effect.orDie, Effect.asVoid),
        machine: (userId, machineId) =>
          db
            .select()
            .from(machines)
            .where(and(eq(machines.userId, userId), eq(machines.id, machineId)))
            .limit(1)
            .pipe(
              Effect.orDie,
              Effect.map(([row]) => (row ? toMachine(row) : null)),
            ),
        machines: (userId) =>
          db
            .select()
            .from(machines)
            .where(eq(machines.userId, userId))
            .orderBy(desc(machines.lastSeenAt))
            .pipe(
              Effect.orDie,
              Effect.map((rows) => rows.map(toMachine)),
            ),
        forgetMachine: (userId, machineId) =>
          db
            .delete(machines)
            .where(and(eq(machines.userId, userId), eq(machines.id, machineId)))
            .pipe(Effect.orDie, Effect.asVoid),
        gone: (conversationIds) =>
          Effect.gen(function* () {
            if (conversationIds.length === 0) return [];
            const found = yield* db
              .select({ id: conversations.id })
              .from(conversations)
              .where(inArray(conversations.id, [...conversationIds]))
              .pipe(Effect.orDie);
            const existing = new Set(found.map((row) => row.id));
            return conversationIds.filter((id) => !existing.has(id));
          }),
        chat: (userId, conversationId) =>
          db
            .select({
              conversationId: conversations.id,
              machineId: conversations.machineId,
              folders: conversations.computerFolders,
              permissionLevel: conversations.permissionLevel,
            })
            .from(conversations)
            .where(ownedConversationById(conversationId, userId))
            .limit(1)
            .pipe(
              Effect.orDie,
              Effect.map(([row]) => row ?? null),
            ),
        bind: (userId, conversationId, machineId) =>
          db
            .update(conversations)
            .set({ machineId })
            .where(
              and(ownedConversationById(conversationId, userId), isNull(conversations.machineId)),
            )
            .returning({ id: conversations.id })
            .pipe(Effect.orDie, Effect.map(updated)),
        rebind: (userId, conversationId, machineId) =>
          db
            .update(conversations)
            .set({ machineId, computerFolders: [] })
            .where(ownedConversationById(conversationId, userId))
            .returning({ id: conversations.id })
            .pipe(Effect.orDie, Effect.map(updated)),
        setFolders: (userId, machineId, conversationId, folders) =>
          db
            .update(conversations)
            .set({ computerFolders: folders, machineId })
            .where(
              and(
                ownedConversationById(conversationId, userId),
                // Only the chat's own machine speaks for its folders, or the first to attach one.
                folders.length > 0
                  ? or(eq(conversations.machineId, machineId), isNull(conversations.machineId))
                  : eq(conversations.machineId, machineId),
              ),
            )
            .returning({ id: conversations.id })
            .pipe(Effect.orDie, Effect.map(updated)),
        setPermissionLevel: (userId, conversationId, level) =>
          db
            .update(conversations)
            .set({ permissionLevel: level })
            .where(ownedConversationById(conversationId, userId))
            .returning({ id: conversations.id })
            .pipe(Effect.orDie, Effect.map(updated)),
        grants: (userId) =>
          db
            .select({
              id: networkGrants.id,
              host: networkGrants.host,
              port: networkGrants.port,
              privateNetwork: networkGrants.privateNetwork,
              conversationId: networkGrants.conversationId,
            })
            .from(networkGrants)
            .leftJoin(conversations, eq(conversations.id, networkGrants.conversationId))
            .where(
              and(
                eq(networkGrants.userId, userId),
                // A deleted chat's grants wait with it, and do nothing meanwhile.
                or(isNull(networkGrants.conversationId), isNull(conversations.deletedAt)),
              ),
            )
            .pipe(Effect.orDie),
        addGrant: (userId, grant) =>
          db
            .insert(networkGrants)
            .values({ userId, ...grant })
            .onConflictDoUpdate({
              target: [
                networkGrants.userId,
                networkGrants.conversationId,
                networkGrants.host,
                networkGrants.port,
              ],
              // A private-network approval widens an existing grant; nothing narrows one.
              set: {
                privateNetwork: sql`${networkGrants.privateNetwork} or excluded.private_network`,
              },
            })
            .pipe(Effect.orDie, Effect.asVoid),
        holdsAttachment: (userId, conversationId, attachmentId) =>
          db
            .select({ id: messageAttachments.attachmentId })
            .from(messageAttachments)
            .innerJoin(messages, eq(messages.id, messageAttachments.messageId))
            .innerJoin(conversations, eq(conversations.id, messages.conversationId))
            .where(
              and(
                ownedConversationById(conversationId, userId),
                eq(messageAttachments.attachmentId, attachmentId),
              ),
            )
            .limit(1)
            .pipe(Effect.orDie, Effect.map(updated)),
        sentFiles: (userId, conversationId) =>
          db
            .select({ id: attachments.id, name: attachments.fileName })
            .from(messageAttachments)
            .innerJoin(messages, eq(messages.id, messageAttachments.messageId))
            .innerJoin(attachments, eq(attachments.id, messageAttachments.attachmentId))
            .innerJoin(conversations, eq(conversations.id, messages.conversationId))
            .where(
              and(
                ownedConversationById(conversationId, userId),
                eq(messages.role, "user"),
                eq(messageAttachments.kind, "file"),
              ),
            )
            .orderBy(asc(messages.createdAt), asc(messageAttachments.position))
            .pipe(Effect.orDie),
        removeGrant: (userId, grantId) =>
          db
            .delete(networkGrants)
            .where(and(eq(networkGrants.userId, userId), eq(networkGrants.id, grantId)))
            .returning({ id: networkGrants.id })
            .pipe(Effect.orDie, Effect.map(updated)),
      });
    }),
  );
}
