import { serveJobs } from "../../../server/job-worker.ts";
import { ocrPages, readPages, renderPages, subsetPages } from "./pages.ts";

/** Everything a PDF worker does; the runtime's request and result types come from here. */
export const pdfJobs = {
  read: readPages,
  render: renderPages,
  ocr: ocrPages,
  subset: subsetPages,
};

serveJobs(pdfJobs, { label: "PDF reading" });
