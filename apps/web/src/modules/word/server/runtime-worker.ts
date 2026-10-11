import { serveJobs } from "../../../server/job-worker.ts";
import {
  createWordFile,
  editWordFile,
  inspectWordFile,
  previewWordFile,
  type InspectScope,
} from "./adapter.ts";
import { documentToWord } from "./document-export.ts";
import { wordToDocument } from "./document-import.ts";
import type { DocumentBounds, DocumentForWord } from "./document-tree.ts";

/** Everything a Word worker does; the runtime's request and result types come from here. */
export const wordJobs = {
  create: () => createWordFile(),
  inspect: (request: { readonly bytes: Uint8Array; readonly scope?: InspectScope }) =>
    inspectWordFile(request.bytes, request.scope),
  edit: (request: { readonly bytes: Uint8Array; readonly operations: unknown }) =>
    editWordFile(request.bytes, request.operations),
  preview: (request: { readonly bytes: Uint8Array }) => previewWordFile(request.bytes),
  /** A live document as a Word file, for download. */
  exportDocument: (request: { readonly document: DocumentForWord }) =>
    documentToWord(request.document),
  /** A Word file read as a live document's tree, within the document's bounds. */
  importDocument: (request: { readonly bytes: Uint8Array; readonly bounds: DocumentBounds }) =>
    wordToDocument(request.bytes, request.bounds),
};

serveJobs(wordJobs, { label: "Word processing" });
