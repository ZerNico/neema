import type { Node } from "@tiptap/pm/model";
import type { SheetDoc } from "@chat/sheet/model";
import type { SheetValues } from "@chat/sheet/model/calc";
import { Effect } from "effect";
import { WORD_LIMITS } from "~/modules/word/limits.ts";
import type { DocumentForWord, TreeNode, WordThread } from "~/modules/word/server/document-tree.ts";
import { documentImagePath, type DocumentComment } from "../schema.ts";
import { embedAttrs, embedCaption } from "../editor/sheet-embed.ts";
import { embedMoreText, embedTable } from "../sheet/embed-range.ts";

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

/** Who a comment is by, as a Word comment names its author. */
const commentAuthor = (comment: DocumentComment) =>
  comment.byAssistant ? "Assistant" : (comment.fromFile?.name ?? comment.author?.name ?? "");

/** A thread's comments as one Word comment: Word's own replies need a part the library lacks. */
const threadsForWord = (comments: readonly DocumentComment[]): WordThread[] =>
  comments
    .filter((comment) => comment.id === comment.threadId && !comment.resolvedAt)
    .map((first) => {
      const replies = comments.filter(
        (comment) => comment.threadId === first.id && comment.id !== first.id,
      );
      return {
        id: first.id,
        author: commentAuthor(first),
        date: first.createdAt,
        text: [
          first.body,
          ...replies.map((reply) => `${commentAuthor(reply) || "Someone"}: ${reply.body}`),
        ].join("\n"),
      };
    });

/** A sheet a download's embeds show, as the reader may read it now, calculated. */
export interface EmbeddedSheet {
  title: string;
  doc: SheetDoc;
  values: SheetValues;
}

/** Distinct sheets one download calculates at most; embeds of others keep their caption. */
const EMBEDDED_SHEETS = 20;

/** The sheets the tree's embeds show, in order, once each, up to the download's limit. */
export const embeddedSheetIds = (doc: Node) => {
  const found = new Set<string>();
  doc.descendants((node) => {
    const attrs = node.type.name === "sheetEmbed" ? embedAttrs(node.attrs) : null;
    if (attrs && found.size < EMBEDDED_SHEETS) found.add(attrs.sheet);
    return node.isBlock;
  });
  return [...found];
};

const paragraphOf = (text: string, marks: TreeNode["marks"] = []): TreeNode => ({
  type: "paragraph",
  ...(text ? { content: [{ type: "text", text, ...(marks.length ? { marks } : {}) }] } : {}),
});
const ITALIC = [{ type: "italic" }];

/**
 * An embed as Word has a place for it: its caption line, then a range's
 * cells as a table of the values they show now. A chart, or a sheet the
 * reader cannot read, keeps only the caption.
 */
const embedForWord = (node: TreeNode, sheets: ReadonlyMap<string, EmbeddedSheet>): TreeNode[] => {
  const attrs = embedAttrs(node.attrs ?? {});
  if (!attrs) return [];
  const sheet = sheets.get(attrs.sheet);
  const table = sheet && attrs.range ? embedTable(sheet.doc, sheet.values, attrs.range) : null;
  const caption = sheet ? `${sheet.title} · ${attrs.range ?? "chart"}` : embedCaption(attrs);
  if (!table?.rows.length) return [paragraphOf(caption, ITALIC)];
  const rows = table.rows.map((row) => ({
    type: "tableRow",
    content: row.map((cell) => ({
      type: "tableCell",
      attrs: { colspan: 1, rowspan: 1, colwidth: null },
      content: [
        paragraphOf(cell.text, [
          ...(cell.bold ? [{ type: "bold" }] : []),
          ...(cell.italic ? ITALIC : []),
        ]),
      ],
    })),
  }));
  const more = embedMoreText(table);
  return [
    paragraphOf(caption, ITALIC),
    { type: "table", content: rows },
    ...(more ? [paragraphOf(more, ITALIC)] : []),
  ];
};

const withSheetEmbeds = (node: TreeNode, sheets: ReadonlyMap<string, EmbeddedSheet>): TreeNode =>
  node.content
    ? {
        ...node,
        content: node.content.flatMap((child) =>
          child.type === "sheetEmbed"
            ? embedForWord(child, sheets)
            : [withSheetEmbeds(child, sheets)],
        ),
      }
    : node;

/** What the Word worker builds a document's file from. */
export const wordExportInput = (
  title: string,
  doc: Node,
  comments: readonly DocumentComment[],
  images: Record<string, Uint8Array>,
  sheets: ReadonlyMap<string, EmbeddedSheet> = new Map(),
): DocumentForWord => ({
  title,
  tree: withSheetEmbeds(doc.toJSON() as TreeNode, sheets),
  images,
  threads: threadsForWord(comments),
});

/** A file name from a title: what a download keeps of it. */
export const wordFileName = (title: string) => {
  const printable = [...title].filter((character) => character.charCodeAt(0) >= 32).join("");
  return `${
    printable
      .replace(/[\\/:*?"<>|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "Document"
  }.docx`;
};
