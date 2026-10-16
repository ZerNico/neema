import type { AxisLayout } from "./layout.ts";
import type { GridOverlay } from "./grid-types.ts";

/** Charts and pictures laid over the cells, each from its anchor cell's corner. */
export function GridOverlays({
  overlays,
  rows,
  cols,
  rowIndex,
  colIndex,
}: {
  overlays: readonly GridOverlay[];
  rows: AxisLayout;
  cols: AxisLayout;
  rowIndex: ReadonlyMap<string, number>;
  colIndex: ReadonlyMap<string, number>;
}) {
  return overlays.flatMap((overlay) => {
    const row = rowIndex.get(overlay.at.r);
    const col = colIndex.get(overlay.at.c);
    if (row === undefined || col === undefined) return [];
    return [
      <figure
        key={overlay.key}
        aria-label={overlay.label}
        className="absolute z-[5]"
        style={{
          top: rows.starts[row]! + (overlay.offset?.y ?? 0),
          left: cols.starts[col]! + (overlay.offset?.x ?? 0),
          width: overlay.width,
          height: overlay.height,
        }}
        // A drawing is looked at, not selected through: the cells under it stay as they are.
        onPointerDown={(event) => event.stopPropagation()}
      >
        {overlay.content}
      </figure>,
    ];
  });
}
