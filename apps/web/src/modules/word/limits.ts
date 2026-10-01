/** Bounds for everything a Word file may be before any worker spends time on it. */
export const WORD_LIMITS = {
  compressedBytes: 20 * 1024 * 1024,
  /** What the package may inflate to, in total and per part; checked before parsing. */
  expandedBytes: 128 * 1024 * 1024,
  partBytes: 64 * 1024 * 1024,
  /** Output bytes allowed per compressed byte, for one part and the package. */
  expansionRatio: 100,
  parts: 2_000,
  /** Top-level paragraphs and tables in the body. */
  blocks: 50_000,
  operationsPerCall: 40,
  /** Characters of new text one call may write. */
  charsPerCall: 200_000,
  paragraphChars: 20_000,
  /** One inspection window: blocks and text the model sees at once. */
  windowBlocks: 400,
  windowChars: 40_000,
  /** A table cell's text in an inspection; tables show at most this many rows and columns. */
  cellChars: 300,
  tableRows: 60,
  tableColumns: 20,
  tableCellsPerCall: 5_000,
  /** A user preview. */
  previewBlocks: 600,
  previewChars: 200_000,
  /** Pictures a preview carries inline; larger ones show as a placeholder. */
  previewPictureBytes: 2 * 1024 * 1024,
  previewPicturesBytes: 8 * 1024 * 1024,
  /** Pictures one edit may insert. */
  imageBytes: 10 * 1024 * 1024,
  editImageBytes: 20 * 1024 * 1024,
} as const;

export const WORD_WORKERS = {
  defaultWorkers: 2,
  maxWorkers: 8,
  queue: 8,
  timeoutMs: 30_000,
  heapMb: 1024,
  /** Jobs one person may run at once; more wait, so nobody fills every worker. */
  perOwner: 2,
} as const;
