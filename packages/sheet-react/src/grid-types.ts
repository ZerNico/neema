import type { Axis } from "@chat/sheet/model";
import type { ReactNode } from "react";
import type { NumberFormatKind } from "./format-commands.ts";
import type { CellRef, SheetSelection } from "./selection.ts";

/** What the keyboard asks of the sheet; the app decides what each writes. */
export type GridCommand =
  | {
      readonly kind:
        | "clear"
        | "undo"
        | "redo"
        | "find"
        | "filter"
        | "link"
        | "group"
        | "ungroup"
        | "print";
    }
  | { readonly kind: "fill"; readonly direction: "down" | "right" }
  | { readonly kind: "toggle"; readonly property: "bold" | "italic" | "underline" | "strike" }
  /** Excel's Ctrl+Shift number formats; the app writes each in the sheet's locale. */
  | { readonly kind: "numberFormat"; readonly format: NumberFormatKind }
  | { readonly kind: "borders"; readonly border: "outer" | "none" }
  | { readonly kind: "autosum" }
  | { readonly kind: "hide"; readonly axis: Axis; readonly hidden: boolean }
  /** Whole rows or columns selected, as Ctrl+Shift+Plus and Ctrl+Minus act on them. */
  | { readonly kind: "insert" | "delete"; readonly axis: Axis }
  | { readonly kind: "comment" }
  | { readonly kind: "sheet"; readonly step: 1 | -1 }
  | { readonly kind: "newSheet" };

/** Someone else's selection, drawn in their colour. */
export interface GridDecoration {
  readonly key: string;
  readonly selection: SheetSelection;
  readonly color: string;
  /** A person's name beside their selection; none for a highlight such as a find match. */
  readonly label?: string;
  /** A corner mark on the cell instead of an outline, as a comment has. */
  readonly marker?: boolean;
}

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
  /** The smallest it may be resized to. */
  readonly min?: { readonly width: number; readonly height: number };
}

/** Where an overlay was moved or resized to: the cell under its top-left corner, how far into it, and its size. */
export interface OverlayChange {
  readonly at: CellRef;
  readonly offset: { readonly x: number; readonly y: number };
  readonly width: number;
  readonly height: number;
}
