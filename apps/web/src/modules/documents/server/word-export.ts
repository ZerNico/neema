import type { Node } from "@tiptap/pm/model";
import { Effect } from "effect";
import { m } from "~/paraglide/messages.js";
import { baseLocale, type Locale } from "~/paraglide/runtime.js";
import { WORD_LIMITS } from "~/modules/word/limits.ts";
import type { DocumentForWord, TreeNode, WordThread } from "~/modules/word/server/document-tree.ts";
import { documentImagePath, type DocumentComment } from "../schema.ts";

export const DOCX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Image bytes one download embeds, leaving room under the Word file cap for the rest. */
const EXPORT_IMAGE_BYTES = WORD_LIMITS.compressedBytes - 4 * 1024 * 1024;

/** The attachment a document image's address names, when it is this document's. */
export const documentImageOf = (documentId: string, src: unknown) => {
  if (typeof src !== "string") return null;
  const prefix = documentImagePath(documentId, "");
  if (!src.startsWith(prefix)) return null;
  const id = decodeURIComponent(src.slice(prefix.length));
  return id && !id.includes("/") ? id : null;
};

/** Every image address in the tree, in order, once each. */
export const imageSources = (doc: Node) => {
  const found = new Set<string>();
  doc.descendants((node) => {
    if (node.type.name === "image" && typeof node.attrs.src === "string") found.add(node.attrs.src);
    return true;
  });
  return [...found];
};

/**
 * Reads the document's own images for a download, in order, until the
 * budget: a picture past it, or one no longer readable, is left out.
 */
export const exportImages = <E, R>(
  documentId: string,
  doc: Node,
  read: (attachmentId: string) => Effect.Effect<Uint8Array | null, E, R>,
) =>
  Effect.gen(function* () {
    const images: Record<string, Uint8Array> = {};
    let total = 0;
    for (const src of imageSources(doc)) {
      const attachmentId = documentImageOf(documentId, src);
      if (!attachmentId) continue;
      const bytes = yield* read(attachmentId);
      if (!bytes || total + bytes.length > EXPORT_IMAGE_BYTES) continue;
      total += bytes.length;
      images[src] = bytes;
    }
    return images;
  });

/** Who a comment is by, as a Word comment names its author, in the reader's language. */
const commentAuthor = (comment: DocumentComment, locale: Locale) =>
  (comment.byAssistant
    ? m.documents_comments_assistant({}, { locale })
    : (comment.fromFile?.name ?? comment.author?.name)) ||
  m.documents_comments_someone({}, { locale });

/** A thread's comments as one Word comment: Word's own replies need a part the library lacks. */
const threadsForWord = (comments: readonly DocumentComment[], locale: Locale): WordThread[] =>
  comments
    .filter((comment) => comment.id === comment.threadId && !comment.resolvedAt)
    .map((first) => {
      const replies = comments.filter(
        (comment) => comment.threadId === first.id && comment.id !== first.id,
      );
      return {
        id: first.id,
        author: commentAuthor(first, locale),
        date: first.createdAt,
        text: [
          first.body,
          ...replies.map((reply) => `${commentAuthor(reply, locale)}: ${reply.body}`),
        ].join("\n"),
      };
    });

/** What the Word worker builds a document's file from. */
export const wordExportInput = (
  title: string,
  doc: Node,
  comments: readonly DocumentComment[],
  images: Record<string, Uint8Array>,
  locale: Locale = baseLocale,
): DocumentForWord => ({
  title,
  tree: doc.toJSON() as TreeNode,
  images,
  threads: threadsForWord(comments, locale),
});

/** A file name from a title: what a download keeps of it. */
export const wordFileName = (title: string, locale: Locale = baseLocale) => {
  const printable = [...title].filter((character) => character.charCodeAt(0) >= 32).join("");
  return `${
    printable
      .replace(/[\\/:*?"<>|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || m.documents_fallback_title({}, { locale })
  }.docx`;
};
