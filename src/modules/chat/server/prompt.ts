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
}

// Only the three methods the builder needs, so unit tests can hand it plain
// objects instead of standing up the whole layer graph.
export interface PromptDeps {
  readonly attachments: Pick<
    AttachmentRepo["Service"],
    "listWithBlobsForMessages" | "cacheParsedText"
  >;
  readonly store: Pick<BlobStore["Service"], "get">;
  readonly parser: Pick<DocumentParser["Service"], "parsePdf" | "availability">;
}

const PDF_TEXT_LABEL = "Text extracted from attached PDF";

const decoder = new TextDecoder();

/**
 * Rebuilds the prompt history from stored messages, resolving each attachment
 * link to real bytes.
 *
 * Nothing about an attachment lives in the message text — the link is the only
 * record — so every generation re-decides how to deliver it: natively when the
 * model reads files, as locally extracted text when it does not.
 */
export const buildHistoryMessages = Effect.fn("chat.buildHistoryMessages")(function* (
  deps: PromptDeps,
  input: {
    messages: ReadonlyArray<HistoryMessage>;
    searchEnabled: boolean;
    /** Model accepts non-image file parts (catalog `files` capability). */
    modelSupportsFiles: boolean;
  },
) {
  const plain = (message: HistoryMessage): Prompt.MessageEncoded => ({
    role: message.role,
    content:
      // Without search there is no recap block, so history markers would teach
      // the model to emit unresolvable citations — strip them.
      message.role === "assistant" && !input.searchEnabled
        ? stripCitationMarkers(message.content)
        : message.content,
  });

  const rows = yield* deps.attachments.listWithBlobsForMessages(
    input.messages.filter((message) => message.role === "user").map((message) => message.id),
  );
  if (rows.length === 0) return input.messages.map(plain);

  const byMessage = new Map<string, Array<AttachmentWithBlob>>();
  for (const row of rows) {
    const list = byMessage.get(row.messageId);
    if (list) list.push(row);
    else byMessage.set(row.messageId, [row]);
  }

  // The same file attached to several turns is one blob; read it once.
  const loaded = new Map<string, Uint8Array>();
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
    // one that produced them — a better parser must not be shadowed by old text.
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
    if (message.content.trim() !== "") parts.push({ type: "text", text: message.content });

    messages.push({ role: "user", content: parts });
  }
  return messages;
});
