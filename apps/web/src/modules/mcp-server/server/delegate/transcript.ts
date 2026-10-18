import { Effect, Option } from "effect";
import type { MessageAttachment } from "~/modules/attachments/schema.ts";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { ChatRepo, type MessageRow, type ToolCallRow } from "~/modules/chat/server/repo.ts";
import { StreamEngine } from "~/modules/chat/server/streaming.ts";
import { citedSourceIndexes } from "~/modules/chat/ui/citations.ts";
import { readPresentedQuestions } from "~/modules/tools/ask-user-schema.ts";
import type { Source } from "~/modules/tools/source-schema.ts";
import { mergeSources } from "~/modules/tools/sources.ts";
import { generationFailureReason } from "~/modules/chat/generation-failure.ts";
import { absoluteSource, decodeSources, outsideText, renderAnswer, sourcesIn } from "./answer.ts";

type TranscriptMessage = Pick<
  MessageRow,
  | "id"
  | "role"
  | "content"
  | "status"
  | "error"
  | "createdAt"
  | "generationId"
  | "originClientName"
  | "questionResponse"
  | "steeredIntoMessageId"
>;

export interface TranscriptInput {
  readonly messages: ReadonlyArray<TranscriptMessage>;
  readonly toolCalls: ReadonlyArray<
    Pick<ToolCallRow, "messageId" | "toolName" | "result" | "researchRunId" | "arguments">
  >;
  readonly attachments: ReadonlyArray<Pick<MessageAttachment, "messageId" | "fileName">>;
  /** Sources registered before the first message, which its answers may cite. */
  readonly priorSources: ReadonlyArray<Source>;
  readonly origin: string;
}

const statusNote = (message: TranscriptMessage) => {
  switch (message.status) {
    case "streaming":
      return "_(still answering)_";
    case "aborted":
      return "_(stopped before it finished)_";
    case "error": {
      const reason = generationFailureReason(message.error?.message);
      return `_(failed${reason ? `: ${reason}` : ""})_`;
    }
    default:
      return null;
  }
};

const toolSummary = (calls: TranscriptInput["toolCalls"]) => {
  const counts = new Map<string, number>();
  // A research run's own workers are its business; the call that started it is listed.
  for (const call of calls)
    if (!call.researchRunId) counts.set(call.toolName, (counts.get(call.toolName) ?? 0) + 1);
  if (counts.size === 0) return null;
  return `_Tools: ${[...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(", ")}_`;
};

/** The questions an answer put to the person, which its text does not repeat. */
export const askedIn = (calls: TranscriptInput["toolCalls"]) =>
  calls.flatMap((call) =>
    call.toolName === "ask_user"
      ? (readPresentedQuestions(call.result) ?? []).map((q) => q.question)
      : [],
  );

/**
 * A run of turns as Markdown for an outside model. Citation numbers are the
 * chat's, so each answer's footnotes resolve against every source registered
 * up to it, not only its own.
 */
export const renderTranscript = (input: TranscriptInput) => {
  // Grows answer by answer: a later search never backs an earlier claim.
  let known = mergeSources(input.priorSources);
  return input.messages
    .map((message) => {
      const calls = input.toolCalls.filter((call) => call.messageId === message.id);
      const files = input.attachments
        .filter((file) => file.messageId === message.id)
        .map((file) => file.fileName);
      const when = message.createdAt.toISOString();
      if (message.role === "user") {
        const who = message.questionResponse
          ? "Person, answering"
          : message.steeredIntoMessageId
            ? "Person, while it answered"
            : "Person";
        const via = message.originClientName ? ` (via ${message.originClientName})` : "";
        return [
          `### ${who}${via}, ${when}`,
          message.content,
          files.length ? `_Files: ${files.join(", ")}_` : null,
        ]
          .filter(Boolean)
          .join("\n\n");
      }
      known = mergeSources([...known, ...calls.flatMap((call) => sourcesIn(call.result))]);
      const cited = citedSourceIndexes(message.content);
      const sources = known
        .filter((source) => cited.has(source.index))
        .map((source) => absoluteSource(source, input.origin));
      return [
        `### Assistant, ${when} (messageId ${message.id})`,
        toolSummary(calls),
        renderAnswer(outsideText(message.content, input.origin), sources),
        ...askedIn(calls).map((question) => `> Asked: ${question}`),
        files.length ? `_Files: ${files.join(", ")}_` : null,
        statusNote(message),
      ]
        .filter(Boolean)
        .join("\n\n");
    })
    .join("\n\n");
};

/**
 * Whether two reads of a window show the same attempts. Unlike the chat view's
 * check, text an answer is still writing may differ: waiting for it to settle
 * would hold the read for the whole answer.
 */
const sameAttempts = (before: ReadonlyArray<MessageRow>, after: ReadonlyArray<MessageRow>) =>
  before.length === after.length &&
  before.every((message, index) => {
    const current = after[index]!;
    return (
      message.id === current.id &&
      message.generationId === current.generationId &&
      message.editedAt?.getTime() === current.editedAt?.getTime()
    );
  });

/**
 * The newest `turns` turns before `beforeId` (or the chat's end), read the way
 * the chat view reads them: again if a retry or edit changed an attempt in
 * between, so one page never mixes two.
 */
export const readTranscript = Effect.fn("mcp.readTranscript")(function* (input: {
  userId: string;
  conversationId: string;
  turns: number;
  beforeId: string | null;
  origin: string;
}) {
  const repo = yield* ChatRepo;
  const attachments = yield* AttachmentRepo;
  // An answer whose writer died reads as failed, not as still answering.
  const engine = yield* Effect.serviceOption(StreamEngine);
  if (Option.isSome(engine)) yield* engine.value.reapOrphans;
  const range = input.beforeId ? { beforeId: input.beforeId } : {};
  while (true) {
    const start = yield* repo.findWindowStart(
      input.conversationId,
      input.turns,
      input.beforeId ?? undefined,
    );
    const messages = yield* repo.listMessageWindow(input.conversationId, {
      fromId: start,
      ...range,
    });
    const ids = messages.map((m) => m.id);
    const cited = new Set(messages.flatMap((m) => [...citedSourceIndexes(m.content)]));
    const first = messages[0];
    const [toolCalls, files, prior, older] = yield* Effect.all(
      [
        repo.listToolCalls(ids.filter((_, i) => messages[i]!.role === "assistant")),
        attachments.listForMessages(ids),
        first && cited.size
          ? repo.listSourcesBefore(input.conversationId, first.id, [...cited])
          : Effect.succeed([]),
        start ? repo.hasMessagesBefore(input.conversationId, start) : Effect.succeed(false),
      ],
      { concurrency: "unbounded" },
    );
    const again = yield* repo.listMessageWindow(input.conversationId, {
      fromId: start,
      ...range,
    });
    if (!sameAttempts(messages, again)) continue;
    // Deleted while it was read: the page is not handed out.
    yield* repo.getConversation(input.userId, input.conversationId);
    return {
      messages,
      toolCalls,
      markdown: renderTranscript({
        messages,
        toolCalls,
        attachments: files,
        priorSources: decodeSources(prior),
        origin: input.origin,
      }),
      olderCursor: older ? start : null,
    };
  }
});
