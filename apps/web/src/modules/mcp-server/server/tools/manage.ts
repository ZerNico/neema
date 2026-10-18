import { Effect, Schema } from "effect";
import { ChatRepo } from "~/modules/chat/server/repo.ts";
import { ChatService } from "~/modules/chat/server/service.ts";
import { ConversationTitle } from "~/modules/chat/schema.ts";
import { outsideText } from "../delegate/answer.ts";
import { askedIn, readTranscript } from "../delegate/transcript.ts";
import { chatUrl } from "./chats.ts";
import {
  DEFAULT_WAIT_SECONDS,
  WaitSeconds,
  explainRefusal,
  followTurn,
  ownedMessage,
  resumeTurn,
} from "./delegate.ts";
import { defineTool, refused, result } from "./define.ts";

const Turns = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 30 }));
const DEFAULT_TURNS = 10;

const noChat = () =>
  Effect.fail(refused("There is no chat with that id. Call list_chats or search_chats."));

const ownedChat = (userId: string, chatId: string) =>
  Effect.flatMap(ChatRepo, (repo) => repo.getConversation(userId, chatId)).pipe(
    Effect.catchTag("ConversationNotFound", noChat),
  );

const isTitle = Schema.is(ConversationTitle);

const BUSY =
  "This chat is still answering. Wait for it with get_message, or stop it with stop_generation.";

const retryRefusal = (
  error: { readonly _tag: string; readonly reason?: unknown },
  named: boolean,
) => {
  switch (error._tag) {
    case "RetryNotAllowed":
      return `This answer can't be retried: ${String(error.reason)}.`;
    case "ModelNotFound":
      return named
        ? "That model isn't available. Call list_models."
        : "Its model isn't available any more. Pass a modelId from list_models.";
    case "ConversationBusy":
      return BUSY;
    case "MessageNotFound":
      return "That message isn't in its chat any more. Read the chat again.";
    case "AttachmentUnsupported":
    case "AttachmentNotAvailable":
      return "That model can't read the files in this chat. Pick another one.";
    default:
      return explainRefusal(error);
  }
};

const changes = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

export const readChat = defineTool({
  name: "read_chat",
  title: "Read a chat",
  description:
    "Reads a chat, oldest first: the latest turns as Markdown, each answer with its sources and the tools it used, and each message on its own in the structured result. A turn includes any questions the answer asked and the person's replies. Pass `cursor` from a previous read for the turns before it.",
  scope: "chats:read",
  input: Schema.Struct({
    chatId: Schema.String,
    turns: Schema.optionalKey(Turns),
    cursor: Schema.optionalKey(Schema.String),
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  run: (args, { principal, origin }) =>
    Effect.gen(function* () {
      const chat = yield* ownedChat(principal.userId, args.chatId);
      if (args.cursor !== undefined) {
        const at = yield* ChatRepo.use((repo) => repo.getMessage(args.cursor!));
        // Only a turn's opening message starts a page, as the chat view pages.
        const opensTurn =
          at?.conversationId === chat.id &&
          at.role === "user" &&
          !at.steeredIntoMessageId &&
          !at.questionResponse;
        if (!opensTurn)
          return yield* refused(
            "That cursor isn't a turn of this chat: use the olderCursor a read of this chat gave.",
          );
      }
      const page = yield* readTranscript({
        userId: principal.userId,
        conversationId: chat.id,
        turns: args.turns ?? DEFAULT_TURNS,
        beforeId: args.cursor ?? null,
        origin,
      }).pipe(Effect.catchTag("ConversationNotFound", noChat));
      const url = chatUrl(origin, chat.id);
      const title = chat.title ?? "Untitled";
      const live = page.messages.find((m) => m.status === "streaming");
      const text = [
        `# ${title}`,
        `Chat: ${url}${chat.temporary ? " (temporary)" : ""}${chat.archivedAt ? " (archived)" : ""}`,
        chat.mode === "work"
          ? "This is a Work chat: it continues only in the desktop app, so send_message and retry_message refuse it."
          : null,
        page.olderCursor ? `Earlier turns: read_chat with cursor ${page.olderCursor}` : null,
        page.markdown || "This chat has no messages yet.",
        live
          ? `The last answer is still being written: get_message with messageId ${live.id} waits for it.`
          : null,
      ]
        .filter(Boolean)
        .join("\n\n");
      return result(text, {
        chatId: chat.id,
        title,
        url,
        temporary: chat.temporary,
        archived: chat.archivedAt !== null,
        work: chat.mode === "work",
        projectId: chat.projectId,
        olderCursor: page.olderCursor,
        // Each message's own text, so who said what never rests on headings
        // the text itself could imitate.
        messages: page.messages.map((m) => ({
          id: m.id,
          role: m.role,
          status: m.status,
          generationId: m.generationId ?? null,
          createdAt: m.createdAt.toISOString(),
          content: m.role === "assistant" ? outsideText(m.content, origin) : m.content,
          asked: askedIn(page.toolCalls.filter((call) => call.messageId === m.id)),
          via: m.originClientName,
          answering: m.questionResponse !== null,
          steered: m.steeredIntoMessageId !== null,
        })),
      });
    }),
});

export const retryMessage = defineTool({
  name: "retry_message",
  title: "Retry an answer",
  description:
    "Writes an answer again, optionally with another model, and waits for it like send_message. Everything after that answer in the chat is deleted, as a retry in the app does.",
  scope: "chats:write",
  input: Schema.Struct({
    messageId: Schema.String,
    modelId: Schema.optionalKey(Schema.String),
    waitSeconds: Schema.optionalKey(WaitSeconds),
  }),
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  resume: resumeTurn,
  run: (args, context) =>
    Effect.gen(function* () {
      const userId = context.principal.userId;
      const message = yield* ownedMessage(userId, args.messageId);
      const retried = yield* ChatService.use((chats) =>
        chats.retryMessage({
          userId,
          conversationId: message.conversationId,
          messageId: message.id,
          ...(args.modelId ? { modelId: args.modelId } : {}),
        }),
      ).pipe(
        // Like a send, accepted whole: the reset and the new attempt's start.
        Effect.uninterruptible,
        Effect.catch((error) =>
          Effect.fail(refused(retryRefusal(error, args.modelId !== undefined))),
        ),
      );
      return yield* followTurn(
        {
          chatId: message.conversationId,
          messageId: retried.assistantMessageId,
          generationId: retried.generationId,
        },
        args.waitSeconds ?? DEFAULT_WAIT_SECONDS,
        context,
      );
    }),
});

export const branchChat = defineTool({
  name: "branch_chat",
  title: "Branch a chat",
  description:
    "Copies a chat up to and including one answer into a new chat, which can then go its own way with send_message. Without messageId it copies through the latest finished answer.",
  scope: "chats:write",
  input: Schema.Struct({
    chatId: Schema.String,
    messageId: Schema.optionalKey(Schema.String),
  }),
  annotations: changes,
  run: (args, { principal, origin }) =>
    Effect.gen(function* () {
      const userId = principal.userId;
      const chat = yield* ownedChat(userId, args.chatId);
      const messageId =
        args.messageId ??
        (yield* ChatRepo.use((repo) => repo.listMessages(chat.id))).findLast(
          (m) => m.role === "assistant" && m.status === "complete",
        )?.id;
      if (!messageId) return yield* refused("This chat has no finished answer to branch from.");
      const branch = yield* ChatService.use((chats) =>
        chats.branchConversation({ userId, conversationId: chat.id, messageId }),
      ).pipe(
        Effect.catch((error) =>
          Effect.fail(
            refused(
              error._tag === "BranchNotAllowed"
                ? `Can't branch there: ${error.reason}.`
                : error._tag === "MessageNotFound"
                  ? "That message isn't in this chat."
                  : error._tag === "ConversationBusy"
                    ? BUSY
                    : explainRefusal(error),
            ),
          ),
        ),
      );
      const url = chatUrl(origin, branch.conversationId);
      return result(`Branched into a new chat: ${branch.conversationId}\nChat: ${url}`, {
        chatId: branch.conversationId,
        url,
        branchedFrom: chat.id,
      });
    }),
});

export const keepChat = defineTool({
  name: "keep_chat",
  title: "Keep a temporary chat",
  description:
    "Keeps a temporary chat: it shows in the sidebar and search and is no longer deleted a day after its last message.",
  scope: "chats:write",
  input: Schema.Struct({ chatId: Schema.String }),
  annotations: { ...changes, idempotentHint: true },
  run: (args, { principal }) =>
    Effect.gen(function* () {
      const chat = yield* ownedChat(principal.userId, args.chatId);
      if (!chat.temporary) return result("That chat is already kept.", { kept: true });
      yield* ChatService.use((chats) =>
        chats.keepConversation({ userId: principal.userId, conversationId: chat.id }),
      ).pipe(Effect.catchTag("ConversationNotFound", noChat));
      return result("Kept.", { kept: true });
    }),
});

export const archiveChat = defineTool({
  name: "archive_chat",
  title: "Archive a chat",
  description:
    "Archives a chat, which hides it from the sidebar but keeps it searchable, or restores it with archived false. Sending to an archived chat restores it too.",
  scope: "chats:write",
  input: Schema.Struct({
    chatId: Schema.String,
    archived: Schema.optionalKey(Schema.Boolean),
  }),
  annotations: { ...changes, idempotentHint: true },
  run: (args, { principal }) =>
    Effect.gen(function* () {
      const chat = yield* ownedChat(principal.userId, args.chatId);
      const archived = args.archived ?? true;
      // A temporary chat is swept, not archived; saying it was would be a lie.
      if (archived && chat.temporary)
        return yield* refused("A temporary chat can't be archived. Keep it with keep_chat first.");
      yield* ChatService.use((chats) =>
        chats.setArchived({ userId: principal.userId, conversationId: chat.id, archived }),
      ).pipe(Effect.catchTag("ConversationNotFound", noChat));
      return result(archived ? "Archived." : "Restored from the archive.", { archived });
    }),
});

export const renameChat = defineTool({
  name: "rename_chat",
  title: "Rename a chat",
  description: "Gives a chat a new title.",
  scope: "chats:write",
  input: Schema.Struct({ chatId: Schema.String, title: Schema.String }),
  annotations: { ...changes, idempotentHint: true },
  run: (args, { principal }) =>
    Effect.gen(function* () {
      const title = args.title.trim();
      if (!isTitle(title)) return yield* refused("Give a title that isn't blank or very long.");
      yield* ChatService.use((chats) =>
        chats.renameConversation({
          userId: principal.userId,
          conversationId: args.chatId,
          title,
        }),
      ).pipe(Effect.catchTag("ConversationNotFound", noChat));
      return result(`Renamed to “${title}”.`, { title });
    }),
});
