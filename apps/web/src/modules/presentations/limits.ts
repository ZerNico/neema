export const PRESENTATION_LIMITS = {
  compressedBytes: 20 * 1024 * 1024,
  expandedBytes: 128 * 1024 * 1024,
  expansionRatio: 100,
  entries: 4096,
  xmlPartBytes: 8 * 1024 * 1024,
  slides: 100,
  shapesPerSlide: 1000,
  textChars: 120_000,
  operationsPerCall: 40,
  rendersPerCall: 4,
  renderWidth: 1280,
  renderPixels: 2_000_000,
  /** Largest picture an edit may add, and largest bitmap a preview decodes. */
  imageBytes: 10 * 1024 * 1024,
  imageSide: 8192,
  imagePixels: 8_000_000,
  /** Pictures one edit call may add or swap in, together. */
  editImageBytes: 20 * 1024 * 1024,
  /** Bitmap pixels one preview decodes across all its pictures. */
  previewImagePixels: 40_000_000,
  tableRows: 50,
  tableColumns: 20,
} as const;

/** How much one inspect or edit result lists; the rest is paged or counted. */
export const INSPECT_LIMITS = {
  pageSlides: 10,
  selectedSlides: 8,
  shapesPerRead: 25,
  /** Shape text per shape when one slide is read, and when several share a reply. */
  shapeText: 1200,
  sharedShapeText: 400,
  textTargets: 12,
  textTargetChars: 100,
  notesChars: 400,
  templateTargets: 24,
  templateOwners: 12,
  layoutsPerPage: 100,
  layoutTargets: 12,
} as const;

/** How the worker pool runs presentation work. */
export const PRESENTATION_WORKERS = {
  defaultWorkers: 2,
  maxWorkers: 8,
  queue: 8,
  timeoutMs: 30_000,
  /** Each worker process's heap: a deck expands to at most 128 MiB of parts. */
  heapMb: 1536,
  /** Jobs one person may run at once; more wait, so nobody fills every worker. */
  perOwner: 2,
} as const;

export const FONT_LIMITS = {
  fileBytes: 15 * 1024 * 1024,
  faces: 60,
  totalBytes: 200 * 1024 * 1024,
  /**
   * Drawing a glyph costs its outline; a font that declares modest maxima can
   * still carry huge ones, so these are measured, not read. Real text faces
   * stay far below them (a complex CJK glyph has a few hundred points).
   */
  pointsPerGlyph: 10_000,
  compositeDepth: 8,
  componentsPerGlyph: 256,
  charStringBytes: 16 * 1024,
} as const;

/** Families the renderer ships equivalents for, so every deck may use them. */
export const BUNDLED_FONTS = ["Calibri", "Cambria", "Arial", "Times New Roman", "Courier New"];
