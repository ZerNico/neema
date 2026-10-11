/**
 * What the grid and the commands share about where a person is: cells by
 * IDs, the selection over them, an edit under way and a fill handle drag.
 * Plain types, so pure commands never depend on the grid component.
 */

export interface CellRef {
  readonly r: string;
  readonly c: string;
}
/** A rectangle from where it started to where it ends now, by IDs, so edits never move it. */
export interface SheetSelection {
  readonly anchor: CellRef;
  readonly head: CellRef;
  /** Ranges selected before this one with Cmd or Ctrl held, as Excel selects several. */
  readonly more?: ReadonlyArray<{ readonly anchor: CellRef; readonly head: CellRef }>;
}
/** A cell being typed into. Typing a fresh value lets arrow keys move on; editing one moves the caret. */
export interface CellEditing {
  readonly at: CellRef;
  readonly text: string;
  readonly mode: "type" | "edit";
}
/** A drag of the fill handle: how many cells past the selection, which way, Ctrl held or not. */
export interface GridFill {
  readonly direction: "down" | "up" | "right" | "left";
  /**
   * Cells to fill, or `"auto"` for a double-click: down as far as the data
   * beside it runs. Below zero, the handle was dragged back in: clear that
   * many of the selection's last rows (down) or columns (right).
   */
  readonly count: number | "auto";
  readonly mode: "auto" | "alternate";
}
