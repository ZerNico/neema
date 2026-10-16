import type { ReactNode } from "react";
import type { CellRef } from "./selection.ts";

/** Something drawn over the cells from a cell's top-left corner, such as a chart. */
export interface GridOverlay {
  readonly key: string;
  readonly at: CellRef;
  /** Where its corner sits inside that cell, in pixels. */
  readonly offset?: { readonly x: number; readonly y: number };
  readonly width: number;
  readonly height: number;
  readonly content: ReactNode;
  /** Its accessible name, such as "Sales chart". */
  readonly label: string;
}
