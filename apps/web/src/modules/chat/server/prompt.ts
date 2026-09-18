import type { AssistantOutput } from "../assistant-output.ts";
import type { ProviderReplay } from "./provider-replay.ts";
import type { ChatRepo } from "./repo.ts";
import { AttachmentNotAvailable, AttachmentUnsupported } from "~/modules/attachments/errors.ts";
import { Effect } from "effect";
import type { Prompt } from "effect/unstable/ai";
import { attachmentKind } from "~/modules/attachments/constants.ts";
import type { BlobStore } from "~/modules/attachments/server/blob-store.ts";
import type { DocumentParser } from "~/modules/attachments/server/document-parser.ts";
import type { AttachmentRepo, AttachmentWithBlob } from "~/modules/attachments/server/repo.ts";
import { buildTextFence } from "~/modules/attachments/server/validation.ts";
import { stripCitationMarkers } from "../citation-markers.ts";

export interface HistoryMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
  readonly createdAt?: Date;
  readonly editedAt?: Date | null;
  readonly completedAt?: Date | null;
  readonly assistantOutput?: AssistantOutput | null;
  readonly providerReplay?: ProviderReplay | null;
}

/**
 * Only the three methods the builder needs, so unit tests can hand it plain
 * objects instead of standing up the whole layer graph.
 */
export interface PromptDeps {
  readonly chat?: Pick<ChatRepo["Service"], "listToolCalls">;
  readonly attachments: Pick<
    AttachmentRepo["Service"],
    "listWithBlobsForMessages" | "cacheParsedText"
  >;
  readonly store: Pick<BlobStore["Service"], "get">;
  readonly parser: Pick<DocumentParser["Service"], "parsePdf" | "availability">;
}

export const PDF_TEXT_LABEL = "Text extracted from attached PDF";

const decoder = new TextDecoder();

const messageTimestamp = (message: HistoryMessage): string => {
  if (message.role === "system") return "";
  const timestamp =
    message.role === "assistant" ? (message.completedAt ?? message.createdAt) : message.createdAt;
  if (!timestamp || !Number.isFinite(timestamp.getTime())) return "";
  const label = message.role === "user" ? "Sent" : message.completedAt ? "Completed" : "Created";
  const edited =
    message.editedAt && Number.isFinite(message.editedAt.getTime())
      ? `; edited: ${message.editedAt.toISOString()}`
      : "";
  return `[${label}: ${timestamp.toISOString()}${edited}]\n`;
};

/**
 * Rebuilds the prompt history from stored messages, resolving each attachment
 * link to real bytes.
 *
 * Nothing about an attachment lives in the message text. The link is the only
 * record, so every generation re-decides how to deliver it: natively when the
 * model reads files, as locally extracted text when it does not.
 */
export const buildHistoryMessages = Effect.fn("chat.buildHistoryMessages")(function* (
  deps: PromptDeps,
  input: {
    messages: ReadonlyArray<HistoryMessage>;
    /** Any web tool armed for this generation: search, the reader, or both. */
    webToolsEnabled: boolean;
    /** Model accepts non-image file parts (catalog `files` capability). */
    modelSupportsFiles: boolean;
    modelSupportsVision?: boolean;
    modelIdentity?: { providerId: string; modelKey: string };
    deferAssistantBytes?: boolean;
    loadedBytes?: Map<string, Uint8Array>;
    expandAssistantTurns?: boolean;
  },
) {
  const normalizeAssistantText = (text: string) =>
    input.webToolsEnabled ? text : stripCitationMarkers(text);
  const plain = (message: HistoryMessage): Prompt.MessageEncoded => ({
    role: message.role,
    content:
      messageTimestamp(message) +
      // Without web tools there is no recap block, so history markers would
      // teach the model to emit unresolvable citations, so strip them.
      (message.role === "assistant" ? normalizeAssistantText(message.content) : message.content),
  });

  const rows = yield* deps.attachments.listWithBlobsForMessages(
    input.messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => message.id),
  );
  if (
    rows.length === 0 &&
    !input.messages.some(
      (message) => message.assistantOutput?.images.length || message.providerReplay?.turns.length,
    )
  )
    return input.messages.map(plain);

  const byMessage = new Map<string, Array<AttachmentWithBlob>>();
  for (const row of rows) {
    const list = byMessage.get(row.messageId);
    if (list) list.push(row);
    else byMessage.set(row.messageId, [row]);
  }

  // The same file attached to several turns is one blob; read it once.
  const loaded = input.loadedBytes ?? new Map<string, Uint8Array>();
  const loadBytes = (row: AttachmentWithBlob) =>
    Effect.suspend(() => {
      const cached = loaded.get(row.storageKey);
      if (cached) return Effect.succeed(cached);
      return deps.store
        .get(row.storageKey)
        .pipe(Effect.tap((bytes) => Effect.sync(() => loaded.set(row.storageKey, bytes))));
    });

  // Resolved on the first PDF that needs parsing, not before.
  let parserKind: string | null | undefined;

  const pdfText = Effect.fn("chat.pdfText")(function* (row: AttachmentWithBlob) {
    if (parserKind === undefined) parserKind = (yield* deps.parser.availability()).kind;
    // Cached extractions are only reusable while the configured backend is the
    // one that produced them, so a better parser must not be shadowed by old text.
    if (row.parsedText !== null && row.parsedWith === parserKind) return row.parsedText;

    const bytes = yield* loadBytes(row);
    const parsed = yield* deps.parser.parsePdf({ bytes, fileName: row.fileName });
    yield* deps.attachments.cacheParsedText({
      blobId: row.blobId,
      text: parsed.text,
      parsedWith: parsed.parsedWith,
    });
    return parsed.text;
  });

  const messages: Array<Prompt.MessageEncoded> = [];
  for (const message of input.messages) {
    const attached = byMessage.get(message.id);
    if (
      message.role === "assistant" &&
      (message.assistantOutput?.images.length || message.providerReplay?.turns.length)
    ) {
      const images = message.assistantOutput?.images ?? [];
      // Metadata-only estimates may compact this entire turn away. Refuse an
      // incompatible retained image only when constructing the actual request.
      if (images.length && !input.deferAssistantBytes && input.modelSupportsVision === false)
        return yield* new AttachmentUnsupported({
          fileName: images[0]!.attachment.fileName,
          reason: "This model cannot read images retained in the conversation.",
        });
      const imagePart = (image: (typeof images)[number]) =>
        Effect.gen(function* () {
          const row = attached?.find((row) => row.id === image.attachment.id);
          if (!row || image.textOffset > message.content.length)
            return yield* new AttachmentNotAvailable({ attachmentId: image.attachment.id });
          return {
            type: "file" as const,
            mediaType: row.mediaType,
            fileName: row.fileName,
            data: input.deferAssistantBytes
              ? new URL("https://deferred-image.invalid/")
              : yield* loadBytes(row),
          };
        });
      const replay = message.providerReplay;
      const compatible =
        replay &&
        input.modelIdentity?.providerId === replay.providerId &&
        input.modelIdentity.modelKey === replay.modelKey;
      const turns =
        input.expandAssistantTurns && replay?.turns.length
          ? [...replay.turns]
          : [
              {
                turnIndex: -1,
                startOffset: 0,
                endOffset: message.content.length,
                reasoningDetails: [],
              },
            ];
      if (input.expandAssistantTurns && replay?.turns.length) {
        const end = turns.at(-1)!.endOffset;
        const trailing = images.filter(
          (image) => !turns.some((turn) => turn.turnIndex === image.turnIndex),
        );
        if (end < message.content.length || trailing.length)
          turns.push({
            turnIndex: trailing[0]?.turnIndex ?? turns.at(-1)!.turnIndex + 1,
            startOffset: end,
            endOffset: message.content.length,
            reasoningDetails: [],
          });
      }
      const protectsText = (turn: (typeof turns)[number]) =>
        compatible && input.expandAssistantTurns && turn.reasoningDetails.length > 0;
      const signedReplay = turns.some(protectsText);
      let timestamp = messageTimestamp(message);
      if (signedReplay) {
        const signedCitations = turns.some((turn) => {
          const text = message.content.slice(turn.startOffset, turn.endOffset);
          return protectsText(turn) && normalizeAssistantText(text) !== text;
        });
        // Never prepend timestamps or strip citations inside an opaque replay unit.
        // This annotation belongs to the same history group, before its assistant
        // turns (and never between a tool call and its result).
        if (timestamp || signedCitations)
          messages.push({
            role: "user",
            content:
              "Historical assistant response metadata:\n" +
              timestamp +
              (signedCitations
                ? "Citation markers in the following historical assistant response are retained for provider replay only. Do not reuse these markers in a new answer.\n"
                : ""),
          });
        timestamp = "";
      }
      const calls =
        input.expandAssistantTurns && deps.chat ? yield* deps.chat.listToolCalls([message.id]) : [];
      for (const turn of turns) {
        const parts: Prompt.AssistantMessagePartEncoded[] = [];
        if (timestamp) {
          parts.push({ type: "text", text: timestamp });
          timestamp = "";
        }
        const appendText = (start: number, end: number) => {
          // Offsets address the persisted UTF-16 string, not its normalized form.
          const raw = message.content.slice(start, end);
          const text = protectsText(turn) ? raw : normalizeAssistantText(raw);
          if (text) parts.push({ type: "text", text });
        };
        let cursor = turn.startOffset;
        for (const image of images.filter(
          (image) => turn.turnIndex === -1 || image.turnIndex === turn.turnIndex,
        )) {
          if (image.textOffset < cursor || image.textOffset > turn.endOffset)
            return yield* new AttachmentNotAvailable({ attachmentId: image.attachment.id });
          if (image.textOffset > cursor) appendText(cursor, image.textOffset);
          parts.push(yield* imagePart(image));
          cursor = image.textOffset;
        }
        if (cursor < turn.endOffset) appendText(cursor, turn.endOffset);
        const turnCalls = calls.filter(
          (call) => call.turnIndex === turn.turnIndex && call.toolName !== "knowledge_context",
        );
        for (const call of turnCalls)
          parts.push({
            type: "tool-call",
            id: call.providerCallId,
            name: call.toolName,
            params: call.arguments,
          });
        messages.push({
          role: "assistant",
          content: parts,
          ...(compatible && input.expandAssistantTurns
            ? {
                options: {
                  openrouter: { imageReplay: true, reasoningDetails: turn.reasoningDetails },
                },
              }
            : {}),
        });
        if (turnCalls.length)
          messages.push({
            role: "tool",
            content: turnCalls.map((call) => ({
              type: "tool-result",
              id: call.providerCallId,
              name: call.toolName,
              isFailure: call.status !== "complete",
              result: call.result ?? { error: "The earlier tool did not complete." },
            })),
          });
      }
      continue;
    }
    if (message.role !== "user" || !attached || attached.length === 0) {
      messages.push(plain(message));
      continue;
    }

    const parts: Array<Prompt.UserMessagePartEncoded> = [];
    for (const row of attached) {
      const kind = attachmentKind(row.mediaType);
      if (kind === "image" || (kind === "pdf" && input.modelSupportsFiles)) {
        parts.push({
          type: "file",
          mediaType: row.mediaType,
          fileName: row.fileName,
          data: yield* loadBytes(row),
        });
        continue;
      }
      const text = kind === "pdf" ? yield* pdfText(row) : decoder.decode(yield* loadBytes(row));
      parts.push({
        type: "text",
        text: buildTextFence({
          fileName: row.fileName,
          text,
          ...(kind === "pdf" ? { label: PDF_TEXT_LABEL } : {}),
        }),
      });
    }
    // The user's own words come last: attachments read as context for them.
    const text = messageTimestamp(message) + message.content;
    if (text.trim() !== "") parts.push({ type: "text", text });

    messages.push({ role: "user", content: parts });
  }
  return messages;
});
