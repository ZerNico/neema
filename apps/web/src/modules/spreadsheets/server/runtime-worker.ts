import { serveJobs } from "../../../server/job-worker.ts";
import {
  createSpreadsheet,
  editSpreadsheet,
  exportLiveSheet,
  importLiveSheet,
  inspectSpreadsheet,
  previewChart,
  previewSpreadsheet,
  type InspectScope,
  type LiveSheetExport,
} from "./adapter.ts";

/** Everything a spreadsheet worker does; the runtime's request and result types come from here. */
export const spreadsheetJobs = {
  create: () => createSpreadsheet(),
  inspect: (request: { readonly bytes: Uint8Array; readonly scope?: InspectScope }) =>
    inspectSpreadsheet(request.bytes, request.scope),
  edit: (request: { readonly bytes: Uint8Array; readonly operations: unknown }) =>
    editSpreadsheet(request.bytes, request.operations),
  exportLive: (request: { readonly sheet: LiveSheetExport }) => exportLiveSheet(request.sheet),
  importLive: (request: { readonly bytes: Uint8Array }) => importLiveSheet(request.bytes),
  preview: (request: { readonly bytes: Uint8Array; readonly sheet?: string }) =>
    previewSpreadsheet(request.bytes, request.sheet),
  chart: (request: {
    readonly bytes: Uint8Array;
    readonly sheet?: string;
    readonly index: number;
  }) => previewChart(request.bytes, request.sheet, request.index),
};

serveJobs(spreadsheetJobs, { label: "Spreadsheet processing" });
