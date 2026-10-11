import { useState, type PointerEvent, type RefObject } from "react";
import type { AxisLayout } from "./layout.ts";
import type { GridFill } from "./selection.ts";

/** The selection's rectangle by row and column indexes, inclusive. */
interface Box {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

/** Follows the pointer across the page until it is let go or the drag is cancelled. */
function followPointer(
  move: (event: globalThis.PointerEvent) => void,
  end: (event: globalThis.PointerEvent) => void,
) {
  const finish = (event: globalThis.PointerEvent) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", finish);
    end(event);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", finish);
  window.addEventListener("pointercancel", finish);
}

/** The cell under a point on the page, by the main pane's coordinates. */
function cellUnder(
  content: RefObject<HTMLDivElement | null>,
  rows: AxisLayout,
  cols: AxisLayout,
  at: { clientX: number; clientY: number },
) {
  const rect = content.current!.getBoundingClientRect();
  return { row: rows.indexAt(at.clientY - rect.top), col: cols.indexAt(at.clientX - rect.left) };
}

/**
 * The fill handle on the selection's corner, and the cells a drag of it
 * would write, outlined while it is dragged. Dragged back inside the
 * selection, it marks the last rows or columns to clear.
 */
export function FillHandle({
  box,
  rows,
  cols,
  content,
  onFill,
}: {
  box: Box;
  rows: AxisLayout;
  cols: AxisLayout;
  content: RefObject<HTMLDivElement | null>;
  onFill: (fill: GridFill) => void;
}) {
  const [filling, setFilling] = useState<{
    direction: GridFill["direction"];
    count: number;
  } | null>(null);
  /** The cell under the pointer, past whichever edge it is furthest beyond. */
  const start = (event: PointerEvent) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    const from = box;
    let current: { direction: GridFill["direction"]; count: number } | null = null;
    followPointer(
      (next) => {
        const { row, col } = cellUnder(content, rows, cols, next);
        const reaches = [
          ["down", row - from.bottom],
          ["up", from.top - row],
          ["right", col - from.right],
          ["left", from.left - col],
        ] as const;
        const [direction, count] = reaches.reduce((best, each) =>
          each[1] > best[1] ? each : best,
        );
        const inside =
          row >= from.top && row <= from.bottom && col >= from.left && col <= from.right;
        const shrink =
          from.bottom - row >= from.right - col
            ? { direction: "down" as const, count: row - from.bottom }
            : { direction: "right" as const, count: col - from.right };
        current = count > 0 ? { direction, count } : inside && shrink.count < 0 ? shrink : null;
        setFilling(current);
      },
      (last) => {
        setFilling(null);
        if (current && last.type === "pointerup")
          onFill({ ...current, mode: last.ctrlKey || last.altKey ? "alternate" : "auto" });
      },
    );
  };
  const preview = filling
    ? (() => {
        const [top, bottom, left, right] =
          filling.count < 0
            ? filling.direction === "down"
              ? [box.bottom + filling.count + 1, box.bottom, box.left, box.right]
              : [box.top, box.bottom, box.right + filling.count + 1, box.right]
            : filling.direction === "down"
              ? [box.bottom + 1, box.bottom + filling.count, box.left, box.right]
              : filling.direction === "up"
                ? [box.top - filling.count, box.top - 1, box.left, box.right]
                : filling.direction === "right"
                  ? [box.top, box.bottom, box.right + 1, box.right + filling.count]
                  : [box.top, box.bottom, box.left - filling.count, box.left - 1];
        const [t, b] = [Math.max(0, top), Math.min(rows.ids.length - 1, bottom)];
        const [l, r] = [Math.max(0, left), Math.min(cols.ids.length - 1, right)];
        return (
          <div
            aria-hidden
            className={`border-primary pointer-events-none absolute z-10 border-2 border-dashed ${filling.count < 0 ? "bg-muted/70" : ""}`}
            style={{
              top: rows.starts[t],
              left: cols.starts[l],
              height: rows.starts[b + 1]! - rows.starts[t]!,
              width: cols.starts[r + 1]! - cols.starts[l]!,
            }}
          />
        );
      })()
    : null;
  return (
    <>
      {preview}
      <div
        role="button"
        aria-label="Fill"
        tabIndex={-1}
        data-fill-handle=""
        className="border-background bg-primary absolute z-20 size-2 cursor-crosshair border"
        style={{
          top: rows.starts[box.bottom + 1]! - 4,
          left: cols.starts[box.right + 1]! - 4,
        }}
        onPointerDown={start}
        onDoubleClick={(event) => {
          event.stopPropagation();
          onFill({ direction: "down", count: "auto", mode: "auto" });
        }}
      />
    </>
  );
}

/**
 * Thin strips on the selection's border that pick it up and move it a whole
 * number of cells at a time; the cells inside keep their clicks. Alt, Ctrl
 * or Cmd held when let go copies instead.
 */
export function MoveEdges({
  box,
  rows,
  cols,
  content,
  onDrag,
}: {
  box: Box;
  rows: AxisLayout;
  cols: AxisLayout;
  content: RefObject<HTMLDivElement | null>;
  onDrag: (shift: { rows: number; cols: number }, copy: boolean) => void;
}) {
  const [shifting, setShifting] = useState<{ rows: number; cols: number } | null>(null);
  const start = (event: PointerEvent) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    const from = cellUnder(content, rows, cols, event);
    const limits = { up: -box.top, left: -box.left };
    let current: { rows: number; cols: number } | null = null;
    followPointer(
      (next) => {
        const at = cellUnder(content, rows, cols, next);
        current = {
          rows: Math.max(limits.up, at.row - from.row),
          cols: Math.max(limits.left, at.col - from.col),
        };
        setShifting(current.rows || current.cols ? current : null);
      },
      (last) => {
        setShifting(null);
        if (current && (current.rows || current.cols) && last.type === "pointerup")
          onDrag(current, last.altKey || last.ctrlKey || last.metaKey);
      },
    );
  };
  const [top, left] = [rows.starts[box.top]!, cols.starts[box.left]!];
  const [bottom, right] = [rows.starts[box.bottom + 1]!, cols.starts[box.right + 1]!];
  const edges = [
    { key: "top", top: top - 3, left, width: right - left, height: 5 },
    { key: "bottom", top: bottom - 2, left, width: right - left - 6, height: 5 },
    { key: "left", top, left: left - 3, width: 5, height: bottom - top },
    { key: "right", top, left: right - 2, width: 5, height: bottom - top - 6 },
  ];
  return (
    <>
      {shifting ? (
        <div
          aria-hidden
          className="border-primary pointer-events-none absolute z-10 border-2 border-dashed"
          style={{
            top: rows.starts[Math.min(rows.ids.length - 1, box.top + shifting.rows)],
            left: cols.starts[Math.min(cols.ids.length - 1, box.left + shifting.cols)],
            height: bottom - top,
            width: right - left,
          }}
        />
      ) : null}
      {edges.map(({ key: edge, ...place }) => (
        <div
          key={edge}
          aria-hidden
          data-move-edge={edge}
          className="absolute z-20 cursor-move"
          style={place}
          onPointerDown={start}
        />
      ))}
    </>
  );
}
