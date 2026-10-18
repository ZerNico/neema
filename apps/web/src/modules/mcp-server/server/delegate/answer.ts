import { Effect, Option, Schema } from "effect";
import { AttachmentRepo } from "~/modules/attachments/server/repo.ts";
import { ChatRepo } from "~/modules/chat/server/repo.ts";
import { fileUri } from "../resources.ts";
import { citedSourceIndexes } from "~/modules/chat/ui/citations.ts";
import { outsideUiFences, scanUiFences } from "~/modules/genui/fences.ts";
import { Source } from "~/modules/tools/source-schema.ts";
import { mergeSources, sourceTarget } from "~/modules/tools/sources.ts";

const decodeSource = Schema.decodeUnknownOption(Source);
export const decodeSources = (values: ReadonlyArray<unknown>) =>
  values.flatMap((value) => Option.toArray(decodeSource(value)));

export const sourcesIn = (result: unknown): Source[] =>
  typeof result === "object" &&
  result !== null &&
  "sources" in result &&
  Array.isArray(result.sources)
    ? decodeSources(result.sources)
    : [];

/** A title as one line of link text: no bracket or line break can end the link or start a heading. */
const linkText = (title: string) => title.replace(/[[\]]/g, "").replace(/\s+/g, " ").trim();

export interface AnswerSource {
  index: number;
  title: string;
  url: string;
}

/**
 * The answer as Markdown an outside model can quote: the text unchanged, with
 * each cited `[^N]` defined by its source's absolute URL. Knowledge excerpts
 * link into this instance, where only their reader may open them.
 */
export const renderAnswer = (content: string, sources: ReadonlyArray<AnswerSource>) =>
  sources.length === 0
    ? content
    : `${content}\n\n${sources.map((s) => `[^${s.index}]: [${linkText(s.title)}](<${s.url.replace(/[<>\s]/g, encodeURIComponent)}>)`).join("\n")}`;

/**
 * Answer text as an outside app can use it: a ```ui block, which only the app
 * draws, is kept behind a note, since its source often holds the data the text
 * points to, and a link into this instance gets its host.
 */
export const outsideText = (content: string, origin: string) => {
  let noted = "";
  let at = 0;
  for (const fence of scanUiFences(content)) {
    noted += `${content.slice(at, fence.start)}_(Interactive content, shown in the app. Its source follows.)_\n\n`;
    at = fence.start;
  }
  noted += content.slice(at);
  // A block's code is left as written; only the prose's links are rewritten.
  return outsideUiFences(noted, (prose) => prose.replace(/\]\((<?)\/(?!\/)/g, `]($1${origin}/`));
};

export const absoluteSource = (source: Source, origin: string): AnswerSource => {
  const target = sourceTarget(source);
  return {
    index: source.index,
    title: source.title,
    url: target.startsWith("/") ? `${origin}${target}` : target,
  };
};

/**
 * One attempt's answer as it stands, bound to `generationId` (null for a
 * branch's copy, which has no attempt until retried). Re-read after the reads
 * that hang off it, so a retry landing in between is reported as superseded
 * rather than mixed into this answer.
 */
export const readAnswer = Effect.fn("mcp.readAnswer")(function* (input: {
  messageId: string;
  generationId: string | null;
  origin: string;
}) {
  const repo = yield* ChatRepo;
  const message = yield* repo.getMessage(input.messageId);
  if (!message) return null;
  const replaced = (current: { generationId?: string | null } | null) =>
    (current?.generationId ?? null) !== input.generationId;
  if (replaced(message))
    return { kind: "superseded" as const, generationId: message.generationId ?? null };
  const cited = citedSourceIndexes(message.content);
  const attachments = yield* AttachmentRepo;
  const [calls, inherited, question, files] = yield* Effect.all([
    repo.listToolCalls([message.id]),
    cited.size
      ? repo.listSourcesBefore(message.conversationId, message.id, [...cited])
      : Effect.succeed([]),
    message.status === "complete"
      ? repo.openQuestion(message.conversationId)
      : Effect.succeed(null),
    // What the answer made: decks, images, a service's files.
    attachments.listForMessages([message.id]),
  ]);
  const after = yield* repo.getMessage(input.messageId);
  if (replaced(after))
    return { kind: "superseded" as const, generationId: after?.generationId ?? null };
  const sources = mergeSources([
    ...calls.flatMap((call) => sourcesIn(call.result)),
    ...decodeSources(inherited),
  ])
    .filter((source) => cited.has(source.index))
    .map((source) => absoluteSource(source, input.origin));
  return {
    kind: "answer" as const,
    status: message.status,
    conversationId: message.conversationId,
    content: outsideText(message.content, input.origin),
    markdown: renderAnswer(outsideText(message.content, input.origin), sources),
    sources,
    files: files.map((file) => ({
      id: file.id,
      name: file.fileName,
      mediaType: file.mediaType,
      size: file.size,
      uri: fileUri(file.id),
    })),
    error: message.error,
    // Only the chat's own tail asks, by the rule an answer is accepted under.
    questions:
      question?.messageId === message.id
        ? { callId: question.callId, questions: question.questions }
        : null,
  };
});
