/** A cell by its row and column keys. */
export interface CellRef {
  readonly r: string;
  readonly c: string;
}
/** A rectangle from where it started to where it ends now. */
export interface SheetSelection {
  readonly anchor: CellRef;
  readonly head: CellRef;
  /** Ranges selected before this one with Cmd or Ctrl held, as Excel selects several. */
  readonly more?: ReadonlyArray<{ readonly anchor: CellRef; readonly head: CellRef }>;
}
