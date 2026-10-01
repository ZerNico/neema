import { serveJobs } from "../../../server/job-worker.ts";
import {
  createWordFile,
  editWordFile,
  inspectWordFile,
  previewWordFile,
  type InspectScope,
} from "./adapter.ts";

/** Everything a Word worker does; the runtime's request and result types come from here. */
export const wordJobs = {
  create: () => createWordFile(),
  inspect: (request: { readonly bytes: Uint8Array; readonly scope?: InspectScope }) =>
    inspectWordFile(request.bytes, request.scope),
  edit: (request: { readonly bytes: Uint8Array; readonly operations: unknown }) =>
    editWordFile(request.bytes, request.operations),
  preview: (request: { readonly bytes: Uint8Array }) => previewWordFile(request.bytes),
};

serveJobs(wordJobs, { label: "Word processing" });
