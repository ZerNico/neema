import { Effect } from "effect";
import { MAX_ATTACHMENT_BYTES } from "~/modules/attachments/constants.ts";
import { WordError } from "~/modules/word/errors.ts";
import {
  IMAGE_REF,
  type ImportedThread,
  type TreeNode,
  type WordAsDocument,
} from "~/modules/word/server/document-tree.ts";
import type { WordRuntime } from "~/modules/word/server/runtime.ts";
import { SAFE_LINK } from "../editor/extensions.ts";
import { DOCUMENT_LIMITS, documentImagePath } from "../schema.ts";
import { DOCX_MEDIA_TYPE } from "./word-export.ts";

/** Where an imported image waits for the document to exist: its stored attachment. */
const ATTACHMENT_REF = "attachment:";

/**
 * A tree read from a Word file, its images already stored as the importer's
 * own uploads, waiting for `DocumentService.create` to claim them and to give
 * threads their IDs.
 */
export interface ImportedText {
  readonly tree: TreeNode;
  readonly images: readonly string[];
  readonly threads: readonly ImportedThread[];
}

/**
 * The imported tree as it is stored: images at the new document's addresses,
 * comment marks on their threads' IDs, links only to web and mail. Anything
 * else the worker sent is dropped here, whatever the file made it say.
 */
export const placeImported = (
  imported: ImportedText,
  documentId: string,
  threadIds: ReadonlyMap<string, string>,
): TreeNode => {
  const claimed = new Set(imported.images);
  const place = (node: TreeNode): TreeNode | null => {
    if (node.type === "image") {
      const src = typeof node.attrs?.src === "string" ? node.attrs.src : "";
      const id = src.startsWith(ATTACHMENT_REF) ? src.slice(ATTACHMENT_REF.length) : "";
      if (!claimed.has(id)) return null;
      return { ...node, attrs: { ...node.attrs, src: documentImagePath(documentId, id) } };
    }
    const marks = node.marks?.flatMap((mark) => {
      if (mark.type === "comment") {
        const thread = threadIds.get(String(mark.attrs?.thread));
        return thread ? [{ type: "comment", attrs: { thread } }] : [];
      }
      if (mark.type === "link")
        return typeof mark.attrs?.href === "string" && SAFE_LINK.test(mark.attrs.href)
          ? [{ type: "link", attrs: { href: mark.attrs.href } }]
          : [];
      return [mark];
    });
    return {
      ...node,
      ...(marks ? { marks } : {}),
      ...(node.content ? { content: node.content.flatMap((child) => place(child) ?? []) } : {}),
    };
  };
  return place(imported.tree) ?? { type: "doc", content: [] };
};

/** A refusal a person or the model can act on, from any failure reading the file. */
const reason = (name: string, error: unknown) =>
  error instanceof WordError ? error.message : `${name} could not be read.`;

/**
 * Reads a Word file for a document to start from, in a Word worker whose
 * package checks and timeout guard the parse, and stores its pictures as the
 * reader's own uploads. Fails with a sentence to show.
 */
export const readWordDocument = <E, R>(
  file: { readonly name: string; readonly mediaType: string; readonly bytes: Uint8Array },
  runtime: WordRuntime | null,
  owner: string,
  storeImage: (image: {
    bytes: Uint8Array;
    mediaType: string;
    name: string;
  }) => Effect.Effect<string, E, R>,
): Effect.Effect<
  { name: string; title: string | null; imported: ImportedText; dropped: string[] },
  string,
  R
> =>
  Effect.gen(function* () {
    const { name } = file;
    if (/\.(?:doc|dot)$/i.test(name))
      return yield* Effect.fail(`${name} is an older Word file; save it as .docx first.`);
    if (!/\.docx$/i.test(name) && file.mediaType !== DOCX_MEDIA_TYPE)
      return yield* Effect.fail(`${name} is not a Word file.`);
    if (!runtime) return yield* Effect.fail("Word files cannot be read on this server.");
    const read: WordAsDocument = yield* Effect.tryPromise({
      try: () =>
        runtime.run(
          {
            kind: "importDocument",
            bytes: file.bytes,
            bounds: {
              blocks: DOCUMENT_LIMITS.blocks,
              chars: DOCUMENT_LIMITS.chars,
              imageBytes: MAX_ATTACHMENT_BYTES,
              comments: DOCUMENT_LIMITS.comments,
              comment: DOCUMENT_LIMITS.comment,
              quote: DOCUMENT_LIMITS.quote,
            },
          },
          undefined,
          { owner },
        ),
      catch: (error) => reason(name, error),
    });
    const stored: string[] = [];
    let unstored = 0;
    for (const [index, image] of read.images.entries()) {
      const extension = image.mediaType.split("/")[1] ?? "png";
      const id = yield* storeImage({
        bytes: image.bytes,
        mediaType: image.mediaType,
        name: `${name.replace(/\.docx$/i, "")} ${index + 1}.${extension === "jpeg" ? "jpg" : extension}`,
      }).pipe(Effect.catch(() => Effect.succeed(null)));
      if (id === null) unstored += 1;
      stored.push(id ?? "");
    }
    const point = (node: TreeNode): TreeNode => {
      const src = node.attrs?.src;
      if (node.type === "image" && typeof src === "string" && src.startsWith(IMAGE_REF)) {
        const id = stored[Number(src.slice(IMAGE_REF.length))] ?? "";
        return { ...node, attrs: { ...node.attrs, src: `${ATTACHMENT_REF}${id}` } };
      }
      return node.content ? { ...node, content: node.content.map(point) } : node;
    };
    return {
      name,
      title: read.title,
      imported: {
        tree: point(read.tree),
        images: stored.filter(Boolean),
        threads: read.threads,
      },
      dropped: [
        ...read.dropped,
        ...(unstored
          ? [`${unstored} picture${unstored === 1 ? "" : "s"} the app couldn’t store`]
          : []),
      ],
    };
  });

/** A title from a file name, for a document started from it without one. */
export const titleFromFile = (name: string) =>
  name
    .replace(/\.[^.]+$/, "")
    .trim()
    .slice(0, DOCUMENT_LIMITS.title) || "Document";
