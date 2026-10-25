import {
  CLIENT_CAPABILITIES_META_KEY,
  inputRequired,
  isInputRequiredResult,
} from "@modelcontextprotocol/server";
import { Duration, Effect, Schema } from "effect";
import { uuidv7 } from "uuidv7";
import { AgentRepo } from "~/modules/agents/server/repo.ts";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "~/modules/attachments/constants.ts";
import { generationFailureReason } from "~/modules/chat/generation-failure.ts";
import { ChatRepo } from "~/modules/chat/server/repo.ts";
import { ChatService } from "~/modules/chat/server/service.ts";
import { ProjectService } from "~/modules/projects/server/service.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import type { PendingIntegrationCall } from "~/modules/integrations/schema.ts";
import { QuestionResponse } from "~/modules/tools/ask-user-schema.ts";
import { readAnswer } from "../delegate/answer.ts";
import {
  checkFiles,
  FileInput,
  MAX_FILES_BYTES,
  removeFiles,
  uploadFiles,
} from "../delegate/files.ts";
import {
  askable,
  askPerson,
  callKey,
  elicitationSupport,
  knownCalls,
  settleAnswers,
  waitForPerson,
  waitingOn,
} from "../delegate/person.ts";
import { watchTurn } from "../delegate/watch.ts";
import { appName } from "../app-name.ts";
import { chatUrl } from "./chats.ts";
import { defineTool, refused, result, type McpToolContext } from "./define.ts";
import type { TurnRequestState } from "../request-state.ts";

/** Clients give up on a request after a minute unless progress keeps it alive. */
export const DEFAULT_WAIT_SECONDS = 45;
export const WaitSeconds = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 300 }));

const AFTER_WAIT =
  "Still answering. Call get_message with this messageId to keep waiting; the answer keeps going either way.";

const notifyProgress = (context: McpToolContext) => {
  const token = context.server.mcpReq["_meta"]?.progressToken;
  let step = 0;
  return (message: string) =>
    token === undefined
      ? Effect.void
      : Effect.promise(() =>
          context.server.mcpReq
            .notify({
              method: "notifications/progress",
              params: { progressToken: token, progress: ++step, message },
            })
            // A client that stopped listening is not this turn's problem.
            .catch(() => undefined),
        );
};

const capabilitiesOf = (context: McpToolContext) =>
  (context.server.mcpReq.envelope as Record<string, unknown> | undefined)?.[
    CLIENT_CAPABILITIES_META_KEY
  ];

/** Whether the attempt followed is still the message's own; a branch copy has none to follow. */
const liveAttempt = (turn: { messageId: string; generationId: string | null }) =>
  Effect.flatMap(ChatRepo, (repo) => repo.getMessage(turn.messageId)).pipe(
    Effect.map(
      (message) =>
        turn.generationId !== null && (message?.generationId ?? null) === turn.generationId,
    ),
  );

/** What the person must decide in the app, for a client that cannot ask them itself. */
const needsPerson = (
  calls: ReadonlyArray<PendingIntegrationCall>,
  ids: { chatId: string; messageId: string; chatUrl: string },
) => {
  const waiting = calls.map((call) => ({
    kind: call.kind === "approval" ? ("approval" as const) : ("question" as const),
    tool: call.label,
    summary: call.summary ?? call.prompt?.message ?? null,
    expiresAt: new Date(call.expiresAt).toISOString(),
  }));
  const lines = waiting.map(
    (w) =>
      `- ${w.kind === "approval" ? "Approve" : "Answer"} ${w.tool}${w.summary ? `: ${w.summary}` : ""} (until ${w.expiresAt})`,
  );
  return result(
    [
      "The answer is waiting for this person:",
      ...lines,
      `Ask them to decide in the app at ${ids.chatUrl}, then call get_message with messageId ${ids.messageId}. If you can show them forms, get_message asks them there again.`,
    ].join("\n"),
    { status: "needs_person", ...ids, waiting },
  );
};

/**
 * Waits on one attempt, then says where it stands in one shape for every
 * tool. When the answer waits on the person, a client that can ask them is
 * handed the questions, with the turn sealed into the request state; any
 * other client is told to send them to the app.
 */
export const followTurn = Effect.fn("mcp.followTurn")(function* (
  turn: { chatId: string; messageId: string; generationId: string | null },
  waitSeconds: number,
  context: McpToolContext,
  options: {
    /** Calls already put to the person; seeing them again is no reason to stop. */
    known?: ReadonlySet<string>;
    /** Wait past calls already waiting, for a client told about them before. */
    patient?: boolean;
    /** Answers given too late, still to be reported once this call has a result. */
    late?: ReadonlyArray<string>;
  } = {},
) {
  const ids = { ...turn, chatUrl: chatUrl(context.origin, turn.chatId) };
  const { userId, clientId, scopes } = context.principal;
  const support = elicitationSupport(capabilitiesOf(context));
  // Whether this client can put this call to its person: per call, since a
  // client may take forms and not pages to visit, or the other way round.
  const canAsk = (call: PendingIntegrationCall) =>
    scopes.has("chats:write") && askable(call, support);
  let known = options.known ?? new Set<string>();
  if (options.patient)
    known = new Set([
      ...known,
      ...knownCalls((yield* waitingOn(userId, turn.messageId)).filter((call) => !canAsk(call))),
    ]);
  // A branch's copy has no attempt to follow; it is read as it is. A zero
  // wait skips the watching, never the reading.
  const follow = Effect.fn("mcp.followTurn.watch")(function* (
    generationId: string,
    deadline: number,
  ) {
    while (true) {
      const outcome = yield* Effect.raceFirst(
        watchTurn({
          messageId: turn.messageId,
          generationId,
          wait: Duration.millis(Math.max(0, deadline - Date.now())),
          onProgress: notifyProgress(context),
        }),
        waitForPerson({
          userId,
          conversationId: turn.chatId,
          messageId: turn.messageId,
          known,
        }).pipe(Effect.as({ kind: "person" } as const)),
      );
      if (outcome.kind !== "person" || Date.now() >= deadline) return outcome;
      // Woken for a call the card decided before it was looked at: keep waiting.
      const waiting = yield* waitingOn(userId, turn.messageId);
      if (waiting.some((call) => !known.has(callKey(call)))) return outcome;
    }
  });
  const watched =
    waitSeconds === 0 || turn.generationId === null
      ? ({ kind: "skipped" } as const)
      : yield* follow(turn.generationId, Date.now() + waitSeconds * 1000);
  const running = () =>
    result(`${AFTER_WAIT}\nmessageId: ${turn.messageId}\nChat: ${ids.chatUrl}`, {
      status: "running",
      ...ids,
    });
  // What waits belongs to the message's live attempt; following a replaced
  // one must never put the replacement's calls to anyone.
  const current =
    watched.kind === "settled" || watched.kind === "superseded" ? null : yield* liveAttempt(turn);
  if (current) {
    const waiting = yield* waitingOn(userId, turn.messageId);
    const fresh = waiting.filter((call) => !known.has(callKey(call)) && canAsk(call));
    const asked = fresh.length ? yield* askPerson(fresh, support) : null;
    // Again once the questions are built: a retry in between parks calls that
    // belong to the new attempt, which this follower must not put to anyone.
    if (asked && (yield* liveAttempt(turn))) {
      const requestState = yield* Effect.promise(() =>
        context.turnState.mint({
          v: 1,
          userId,
          clientId,
          messageId: turn.messageId,
          generationId: turn.generationId,
          asks: asked.asks,
          // Everything put to the person in this call so far, so one dismissed
          // is not asked again before the call ends.
          seen: [...new Set([...known, ...asked.asks.map(callKey)])],
          late: options.late ?? [],
        }),
      );
      return inputRequired({ inputRequests: asked.requests, requestState });
    }
    if (waiting.length) return needsPerson(waiting, ids);
  }
  if (watched.kind === "running") return running();
  const answer = yield* readAnswer({ ...turn, origin: context.origin });
  if (answer === null) return yield* refused("That message is gone.");
  if (watched.kind === "superseded" || answer.kind === "superseded") {
    const generationId = watched.kind === "superseded" ? watched.generationId : answer.generationId;
    return result(
      "Someone retried this answer in the app, so this attempt was replaced. Call get_message without a generationId for the new one.",
      { status: "superseded", ...ids, replacedBy: generationId },
    );
  }
  if (answer.status === "streaming") return running();
  if (answer.questions) {
    const lines = answer.questions.questions.map((q, i) => {
      const choices = q.options
        .map((o, j) => `   ${j}. ${o.label}${o.description ? `: ${o.description}` : ""}`)
        .join("\n");
      return `${i + 1}. ${q.question}${q.multiSelect ? " (choose any)" : ""}${choices ? `\n${choices}` : ""}`;
    });
    return result(
      [
        answer.markdown,
        "The answer asks before going on:",
        ...lines,
        `Reply with send_message, chatId ${turn.chatId}, and answer: { callId: "${answer.questions.callId}", response: { kind: "answers", answers: [{ selected: [option numbers], custom: "free text" }, …one per question] } }, or response { kind: "skip" }.`,
      ]
        .filter(Boolean)
        .join("\n\n"),
      {
        status: "question",
        ...ids,
        answer: answer.content,
        sources: answer.sources,
        questions: answer.questions,
      },
    );
  }
  const status = answer.status;
  const failure = status === "error" ? generationFailureReason(answer.error?.message) : null;
  const tail =
    status === "error"
      ? `\n\nThe answer failed${failure ? `: ${failure}` : "."}`
      : status === "aborted"
        ? "\n\nThe answer was stopped before it finished."
        : "";
  const done = result(`${answer.markdown}${tail}\n\nChat: ${ids.chatUrl}`, {
    status,
    ...ids,
    answer: answer.content,
    sources: answer.sources,
    files: answer.files,
    ...(failure ? { error: failure } : {}),
  });
  // Each file as a link the client reads through resources/read, under the same access check.
  return {
    ...done,
    content: [
      ...done.content,
      ...answer.files.map((file) => ({
        type: "resource_link" as const,
        uri: file.uri,
        name: file.name,
        mimeType: file.mediaType,
        size: file.size,
      })),
    ],
  };
});

/** One of this person's messages, with the chat it belongs to, or a refusal. */
export const ownedMessage = Effect.fn("mcp.ownedMessage")(function* (
  userId: string,
  messageId: string,
) {
  const repo = yield* ChatRepo;
  const message = yield* repo.getMessage(messageId);
  const missing = refused("There is no message with that id.");
  if (!message) return yield* missing;
  yield* repo
    .getConversation(userId, message.conversationId)
    .pipe(Effect.catchTag("ConversationNotFound", () => Effect.fail(missing)));
  // Said only once the chat is known to be theirs.
  if (message.role !== "assistant")
    return yield* refused("That's one of the person's messages; this takes an answer's messageId.");
  return message;
});

/**
 * The call a client makes again once its person answered: settles those
 * answers, then follows the same turn. Its arguments are never read, so a
 * re-sent message cannot start a second turn.
 */
export const resumeTurn = (state: TurnRequestState, context: McpToolContext) =>
  Effect.gen(function* () {
    const { userId, clientId, scopes } = context.principal;
    if (state.userId !== userId || state.clientId !== clientId)
      return yield* refused("Those answers belong to another connection.");
    if (!scopes.has("chats:write"))
      return yield* refused("Answering for this person needs permission to write chats.");
    const message = yield* ownedMessage(userId, state.messageId);
    const turn = {
      chatId: message.conversationId,
      messageId: message.id,
      generationId: state.generationId,
    };
    // Answers for an attempt a retry replaced settle nothing of the new one.
    const settledLate = (yield* liveAttempt(turn))
      ? yield* settleAnswers({
          userId,
          asks: state.asks,
          responses: context.server.mcpReq.inputResponses,
          app: yield* appName(clientId),
        })
      : [];
    // Not asked again in this call: answered, or dismissed and left to the app.
    // A later call may ask once more; the person dismissed one form, not the call.
    // Reported with the call's result, however many questions come first.
    const late = [...state.late, ...settledLate];
    const followed = yield* followTurn(turn, DEFAULT_WAIT_SECONDS, context, {
      known: new Set(state.seen),
      late,
    });
    if (!late.length || isInputRequiredResult(followed)) return followed;
    // Otherwise the person's Allow would read as a timeout with nothing linking the two.
    const note = `The person's answer on ${late.join(", ")} came too late: that call had stopped waiting.`;
    return { ...followed, content: [{ type: "text" as const, text: note }, ...followed.content] };
  });

/** Why a send was refused, in words the calling model can act on. */
export const explainRefusal = (error: { readonly _tag: string }) => {
  switch (error._tag) {
    case "ModelNotFound":
      return "That model isn't available. Call list_models.";
    case "QuestionUnavailable":
      return "That question is no longer open: the chat moved on. Read the chat again.";
    case "AgentNotAvailable":
      return "That agent isn't available. Call list_agents.";
    case "WorkDesktopRequired":
      return "This chat works on files on a computer and can only continue in the desktop app.";
    case "SkillNotAvailable":
    case "SkillRejected":
    case "KnowledgeNotAvailable":
    case "KnowledgeRejected":
      return "A skill or knowledge collection this chat uses is no longer available.";
    case "AccountIneligible":
      return "This account can't start chats right now.";
    case "UsageLimitReached":
      return "reason" in error && typeof error.reason === "string"
        ? `${error.reason} Tell the user.`
        : "The user has reached a usage limit.";
    case "ProjectNotAvailable":
      return "That project isn't available. Call list_projects.";
    case "AttachmentRejected":
      return "reason" in error
        ? `A file was refused: ${String(error.reason)}.`
        : "A file was refused.";
    case "AttachmentUnsupported":
      return "This chat's model can't read one of these files. Pick another model with modelId.";
    default:
      return "reason" in error && typeof error.reason === "string"
        ? `This message can't be sent: ${error.reason}.`
        : "This message can't be sent.";
  }
};

const validTimeZone = (zone: string) => {
  try {
    return Boolean(new Intl.DateTimeFormat("en", { timeZone: zone }).resolvedOptions().timeZone);
  } catch {
    return false;
  }
};

/**
 * The model a send uses: the one named, which the send itself vets; else the
 * chat's or its agent's while this person may still use it; else the default.
 */
const pickModel = Effect.fn("mcp.pickModel")(function* (input: {
  userId: string;
  modelId: string | undefined;
  chatModelId: string | null;
  agentModelId: string | null;
}) {
  if (input.modelId) return input.modelId;
  const models = yield* ProviderRepo.use((repo) => repo.listChatModelsFor(input.userId));
  const usable = new Set(models.map((model) => model.id));
  const remembered = [input.chatModelId, input.agentModelId].find((id) => id && usable.has(id));
  return remembered ?? (models.find((model) => model.isDefault) ?? models[0])?.id ?? null;
});

const Answer = Schema.Struct({ callId: Schema.String, response: QuestionResponse });

export const sendMessage = defineTool({
  name: "send_message",
  title: "Send a message",
  description: [
    "Sends a message as this person and waits for the answer, which comes back as Markdown with its sources.",
    "Without chatId it starts a new chat (kept in the sidebar unless temporary; a temporary chat can't be in a project); with chatId it continues that chat with its whole history.",
    "agentId (from list_agents) starts the chat with an agent; it cannot be changed later. research offers deep research, which takes minutes.",
    "If the answer runs past the wait, the status is running: call get_message to keep waiting. Cancelling this call never stops the answer; stop_generation does.",
    "If the answer asks clarifying questions (status question), reply with answer instead of content.",
    `files attaches up to ${MAX_ATTACHMENTS_PER_MESSAGE} files to content, each as { name, mediaType, data } with the bytes base64-encoded, ${MAX_FILES_BYTES / 1024 / 1024} MB in all.`,
  ].join(" "),
  scope: "chats:write",
  input: Schema.Struct({
    content: Schema.optionalKey(Schema.String),
    chatId: Schema.optionalKey(Schema.String),
    answer: Schema.optionalKey(Answer),
    agentId: Schema.optionalKey(Schema.String),
    modelId: Schema.optionalKey(Schema.String),
    projectId: Schema.optionalKey(Schema.String),
    temporary: Schema.optionalKey(Schema.Boolean),
    search: Schema.optionalKey(Schema.Boolean),
    research: Schema.optionalKey(Schema.Boolean),
    timeZone: Schema.optionalKey(Schema.String),
    files: Schema.optionalKey(Schema.Array(FileInput)),
    waitSeconds: Schema.optionalKey(WaitSeconds),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  resume: resumeTurn,
  run: (args, context) =>
    Effect.gen(function* () {
      const userId = context.principal.userId;
      if ((args.content === undefined) === (args.answer === undefined))
        return yield* refused("Send either content or an answer to the chat's questions.");
      if (args.answer && !args.chatId)
        return yield* refused("An answer goes to the chat that asked: pass its chatId.");
      if (args.chatId && (args.agentId || args.projectId || args.temporary !== undefined))
        return yield* refused(
          "agentId, projectId and temporary only apply when starting a chat; leave out chatId to start one.",
        );
      if (args.timeZone !== undefined && !validTimeZone(args.timeZone))
        return yield* refused("timeZone must be an IANA name such as Europe/Berlin.");
      if (args.files?.length && args.answer)
        return yield* refused("Files go with content, not with an answer to questions.");
      const tooMuch = args.files ? checkFiles(args.files) : null;
      if (tooMuch) return yield* refused(tooMuch);

      const chat = args.chatId
        ? yield* ChatRepo.use((repo) => repo.getConversation(userId, args.chatId!)).pipe(
            Effect.catchTag("ConversationNotFound", () =>
              Effect.fail(
                refused("There is no chat with that id. Call list_chats or search_chats."),
              ),
            ),
          )
        : null;
      if (args.projectId)
        yield* ProjectService.use((projects) => projects.get(userId, args.projectId!)).pipe(
          Effect.catchTag("ProjectNotAvailable", () =>
            Effect.fail(refused("That project isn't available. Call list_projects.")),
          ),
        );
      // A continued chat keeps the agent it was started with; its defaults
      // apply as they do in the composer.
      const agentId = chat
        ? ((yield* ChatRepo.use((repo) => repo.getConversationDefaults(chat.id))).agent?.agentId ??
          null)
        : (args.agentId ?? null);
      const agent = agentId ? yield* AgentRepo.use((repo) => repo.get(userId, agentId)) : null;
      if (args.agentId && !agent)
        return yield* refused("That agent isn't available. Call list_agents.");
      const modelId = yield* pickModel({
        userId,
        modelId: args.modelId,
        chatModelId: chat?.modelId ?? null,
        agentModelId: agent?.row.modelId ?? null,
      });
      if (!modelId) return yield* refused("No chat model is available to this account.");
      const clientName = yield* appName(context.principal.clientId);
      const attachmentIds = args.files?.length
        ? yield* uploadFiles(userId, args.files).pipe(
            Effect.catchTags({
              AttachmentRejected: (error) => Effect.fail(refused(explainRefusal(error))),
              StorageFull: (error) => Effect.fail(refused(`${error.reason} Tell the user.`)),
            }),
          )
        : [];

      // Accepted whole or not at all: a client dropping the request between
      // creating the turn and starting its answer would strand the turn.
      const submit = (searchEnabled: boolean) =>
        Effect.flatMap(ChatService, (chats) =>
          chats.sendMessage({
            userId,
            conversation: chat
              ? { kind: "existing", id: chat.id }
              : {
                  kind: "new",
                  id: uuidv7(),
                  mode: "chat",
                  ...(args.temporary ? { temporary: true } : {}),
                  ...(args.projectId ? { projectId: args.projectId } : {}),
                },
            modelId,
            attachmentIds,
            ...(args.answer
              ? { questionResponse: args.answer }
              : {
                  content: args.content!,
                  searchEnabled,
                  researchEnabled: args.research ?? false,
                }),
            timeZone: args.timeZone ?? "UTC",
            ...(!chat && agent ? { agentId: agent.row.id } : {}),
            origin: {
              clientId: context.principal.clientId,
              clientName,
            },
          }),
        );
      const searchByDefault = agent?.row.searchEnabled ?? true;
      const accepted = yield* submit(args.search ?? searchByDefault).pipe(
        // Search on by default is what the composer does where it can; where
        // it cannot, an unasked-for search is not a reason to refuse.
        Effect.catchIf(
          (error) =>
            args.search === undefined &&
            error._tag === "ToolUnavailable" &&
            error.tool === "web_search",
          () => submit(false),
        ),
        Effect.uninterruptible,
        Effect.map((turn) => ({ ok: true as const, turn })),
        Effect.catch((error) =>
          Effect.succeed(
            error._tag === "ConversationBusy"
              ? ({ ok: false, busy: true } as const)
              : ({ ok: false, busy: false, message: explainRefusal(error) } as const),
          ),
        ),
      );
      if (!accepted.ok) {
        yield* removeFiles(userId, attachmentIds);
        if (!accepted.busy) return yield* refused(accepted.message);
        return result(
          "This chat is still answering. Wait for it with get_message, or stop it with stop_generation.",
          { status: "busy", chatId: args.chatId ?? null },
        );
      }
      const { turn } = accepted;
      if (!turn.generationId) return yield* refused("The answer did not start. Try again.");
      return yield* followTurn(
        {
          chatId: turn.conversationId,
          messageId: turn.assistantMessageId,
          generationId: turn.generationId,
        },
        args.waitSeconds ?? DEFAULT_WAIT_SECONDS,
        context,
      );
    }),
});

export const getMessage = defineTool({
  name: "get_message",
  title: "Get an answer",
  description:
    "Waits for an answer started by send_message and returns it when done, as send_message would. Use it after a running status. It only reads: it never stops or changes the answer.",
  scope: "chats:read",
  input: Schema.Struct({
    messageId: Schema.String,
    generationId: Schema.optionalKey(Schema.String),
    waitSeconds: Schema.optionalKey(WaitSeconds),
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  resume: resumeTurn,
  run: (args, context) =>
    Effect.gen(function* () {
      const message = yield* ownedMessage(context.principal.userId, args.messageId);
      const generationId = args.generationId ?? message.generationId ?? null;
      return yield* followTurn(
        { chatId: message.conversationId, messageId: message.id, generationId },
        args.waitSeconds ?? DEFAULT_WAIT_SECONDS,
        context,
        { patient: true },
      );
    }),
});

export const stopGeneration = defineTool({
  name: "stop_generation",
  title: "Stop an answer",
  description:
    "Stops an answer that is still being written. What it wrote so far is kept. Pass the generationId send_message returned so a newer attempt is never stopped by mistake.",
  scope: "chats:write",
  input: Schema.Struct({
    messageId: Schema.String,
    generationId: Schema.optionalKey(Schema.String),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  run: (args, context) =>
    Effect.gen(function* () {
      const message = yield* ownedMessage(context.principal.userId, args.messageId);
      const generationId = args.generationId ?? message.generationId ?? undefined;
      if (args.generationId && args.generationId !== message.generationId)
        return result(
          "That attempt was already replaced by a retry in the app, which keeps running.",
          { stopped: false, status: "superseded" },
        );
      const { stopped } = yield* ChatService.use((chats) =>
        chats.stopGeneration({
          userId: context.principal.userId,
          conversationId: message.conversationId,
          messageId: message.id,
          ...(generationId ? { generationId } : {}),
        }),
      ).pipe(
        Effect.catchTags({
          ConversationNotFound: () => Effect.succeed({ stopped: false }),
          MessageNotFound: () => Effect.succeed({ stopped: false }),
        }),
      );
      return result(stopped ? "Stopped." : "That answer had already finished.", { stopped });
    }),
});
