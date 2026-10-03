/** The PDF worker pool: reading, rendering and reading scanned pages, all in killable processes. */
export const PDF_WORKERS = {
  defaultWorkers: 1,
  maxWorkers: 4,
  queue: 32,
  /** A text-only read; jobs that read scans pass their own, scaled by pages. */
  timeoutMs: 60_000,
  /** JavaScript heap only: canvas and ONNX memory are native and sit outside it. */
  heapMb: 1024,
  perOwner: 2,
} as const;

export const PDF_RASTER = {
  /** Long edge for reading text from a page image: about 140 dpi on A4. */
  ocrLongEdge: 1600,
  /** Long edge for a page shown to a vision model, the size most providers downscale to. */
  visionLongEdge: 1568,
  /** Small renders that only tell a blank page from drawn content. */
  inkScale: 0.5,
  /** No render is larger than this, whatever a page's declared size. */
  maxPixels: 4_000_000,
  /** Pages handled per job, so cancellation and timeouts stay granular. */
  pagesPerJob: 4,
} as const;

/** Time a job that reads scanned pages may take: a base plus each page's share. */
export const scanJobTimeoutMs = (pages: number) => 30_000 + pages * 15_000;
