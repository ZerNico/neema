import { serveJobs } from "../../../server/job-worker.ts";
import {
  checkFontFile,
  createPresentationDraft,
  editPresentation,
  inspectPresentation,
  renderPresentation,
} from "./adapter.ts";
import { renderWorkbookChart, type WorkbookChart } from "./chart-render.ts";
import type { FontFace } from "./font-file.ts";
import type { InspectScope } from "./inspection.ts";

/** Everything a presentation worker does; the runtime's request and result types come from here. */
export const presentationJobs = {
  create: () => createPresentationDraft(),
  inspect: (request: { readonly bytes: Uint8Array; readonly scope?: InspectScope }) =>
    inspectPresentation(request.bytes, request.scope),
  edit: (request: {
    readonly bytes: Uint8Array;
    readonly operations: unknown;
    readonly fonts?: readonly FontFace[];
    /** Return the layout catalog too, for a deck the model has not inspected. */
    readonly catalog?: boolean;
  }) =>
    editPresentation(
      request.bytes,
      request.operations,
      request.fonts,
      request.catalog ? { catalog: true } : {},
    ),
  render: (request: {
    readonly bytes: Uint8Array;
    readonly slideIds: readonly number[];
    readonly fonts?: readonly FontFace[];
  }) => renderPresentation(request.bytes, request.slideIds, request.fonts),
  font: (request: { readonly path: string }) => checkFontFile(request.path),
  /** A workbook's chart, drawn as PowerPoint draws the same chart. */
  chart: (request: { readonly chart: WorkbookChart; readonly fonts?: readonly FontFace[] }) =>
    renderWorkbookChart(request.chart, request.fonts),
};

serveJobs(presentationJobs, { label: "PowerPoint processing" });
