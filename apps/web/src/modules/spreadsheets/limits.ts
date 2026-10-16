/** Bounds for everything a workbook may be before any worker spends time on it. */
export const SPREADSHEET_LIMITS = {
  compressedBytes: 20 * 1024 * 1024,
  expandedBytes: 128 * 1024 * 1024,
  /** Parts one package may hold, and output bytes allowed per compressed byte. */
  parts: 4_096,
  expansionRatio: 100,
  /** Populated cells one workbook may model; calculation cost is close to linear in them. */
  cells: 1_000_000,
  formulas: 200_000,
  sheets: 50,
  operationsPerCall: 40,
  cellsPerCall: 20_000,
  /** Cells one inspection window shows the model. */
  windowCells: 1_500,
  /** Formula errors listed back; the count is always given. */
  errorsListed: 40,
  /** Excel's own limits for a cell's text and a formula. */
  textChars: 32_767,
  formulaChars: 8_192,
  chartsPerSheet: 20,
  /** Cells one sheet's preview sends; past them, whole rows are left out. */
  previewCells: 100_000,
  /** Pictures one sheet's preview sends, the data URL characters of each and of all. */
  previewImages: 20,
  previewImageChars: 600_000,
  previewImagesChars: 3_000_000,
  /** Merges and conditional formats one sheet's preview sends; past them the rest are left out. */
  previewMerges: 10_000,
  previewRules: 200,
} as const;

export const SPREADSHEET_WORKERS = {
  defaultWorkers: 2,
  maxWorkers: 8,
  queue: 8,
  timeoutMs: 30_000,
  /** Each worker process's heap: a workbook at its cell bound plus the calculation graph. */
  heapMb: 1536,
  /** Jobs one person may run at once; more wait, so nobody fills every worker. */
  perOwner: 2,
} as const;
