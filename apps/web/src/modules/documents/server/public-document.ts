import { publicDocumentImagePath } from "../schema.ts";
import { documentImageOf } from "./word-export.ts";

type Json = Record<string, unknown>;

/**
 * The tree as a public link shows it. Comments are the people's who may read
 * it, so their marks go; the document's own images load through the link,
 * and any other address on this server is dropped, since it would only ask
 * an anonymous reader to sign in.
 */
export const publicTree = (node: Json, documentId: string, token: string): Json | null => {
  if (node.type === "image") {
    const attrs = (node.attrs ?? {}) as Json;
    const attachmentId = documentImageOf(documentId, attrs.src);
    if (attachmentId)
      return { ...node, attrs: { ...attrs, src: publicDocumentImagePath(token, attachmentId) } };
    if (typeof attrs.src === "string" && attrs.src.startsWith("/")) return null;
  }
  const next: Json = { ...node };
  if (Array.isArray(node.marks)) {
    const marks = (node.marks as Json[]).filter((mark) => mark.type !== "comment");
    if (marks.length) next.marks = marks;
    else delete next.marks;
  }
  if (Array.isArray(node.content))
    next.content = (node.content as Json[]).flatMap((child) => {
      const kept = publicTree(child, documentId, token);
      return kept ? [kept] : [];
    });
  return next;
};
