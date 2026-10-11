import type { AxisLayout } from "./layout.ts";
import type { GridOverlay, OverlayChange } from "./grid-types.ts";
import type { OverlayCommand } from "./overlay-place.ts";
import { OverlayFrame } from "./overlay.tsx";

const OVERLAY_MIN = { width: 160, height: 120 };

/**
 * Charts and pictures laid over the cells, each from its anchor cell's
 * corner. Moving one reports the cell under its new corner as its anchor,
 * and every size reported back is unscaled by the zoom.
 */
export function GridOverlays({
  overlays,
  rows,
  cols,
  rowIndex,
  colIndex,
  zoom,
  selected,
  editable,
  onSelect,
  onChange,
  onCommand,
  onLeave,
}: {
  overlays: readonly GridOverlay[];
  rows: AxisLayout;
  cols: AxisLayout;
  rowIndex: ReadonlyMap<string, number>;
  colIndex: ReadonlyMap<string, number>;
  zoom: number;
  selected: string | null;
  editable: boolean;
  onSelect: ((key: string | null) => void) | undefined;
  onChange: ((key: string, change: OverlayChange) => void) | undefined;
  onCommand: ((key: string, command: OverlayCommand) => void) | undefined;
  /** The keyboard going back to the cells, as after a delete or Escape. */
  onLeave: () => void;
}) {
  return overlays.flatMap((overlay) => {
    const row = rowIndex.get(overlay.at.r);
    const col = colIndex.get(overlay.at.c);
    if (row === undefined || col === undefined) return [];
    const offset = {
      x: (overlay.offset?.x ?? 0) * zoom,
      y: (overlay.offset?.y ?? 0) * zoom,
    };
    // The cell under its corner becomes its anchor, the rest an offset, as Excel keeps one.
    const placeAt = (top: number, left: number, width: number, height: number) => {
      const [rowAt, colAt] = [rows.indexAt(top), cols.indexAt(left)];
      onChange?.(overlay.key, {
        at: { r: rows.ids[rowAt]!, c: cols.ids[colAt]! },
        offset: {
          x: Math.round(Math.max(0, left - cols.starts[colAt]!) / zoom),
          y: Math.round(Math.max(0, top - rows.starts[rowAt]!) / zoom),
        },
        width: Math.round(width / zoom),
        height: Math.round(height / zoom),
      });
    };
    return [
      <OverlayFrame
        key={overlay.key}
        label={overlay.label}
        place={{
          top: rows.starts[row]! + offset.y,
          left: cols.starts[col]! + offset.x,
          width: overlay.width * zoom,
          height: overlay.height * zoom,
        }}
        selected={selected === overlay.key}
        editable={editable}
        min={{
          width: (overlay.min ?? OVERLAY_MIN).width * zoom,
          height: (overlay.min ?? OVERLAY_MIN).height * zoom,
        }}
        onSelect={() => onSelect?.(overlay.key)}
        onDeselect={() => {
          onSelect?.(null);
          onLeave();
        }}
        onPlace={(place) =>
          placeAt(Math.max(0, place.top), Math.max(0, place.left), place.width, place.height)
        }
        onNudge={(down, right) => {
          // A cell at a time, keeping how far into its cell it sits.
          const [rowAt, colAt] = [
            Math.min(rows.ids.length - 1, Math.max(0, row + down)),
            Math.min(cols.ids.length - 1, Math.max(0, col + right)),
          ];
          placeAt(
            rows.starts[rowAt]! + Math.min(offset.y, rows.size(rowAt)),
            cols.starts[colAt]! + Math.min(offset.x, cols.size(colAt)),
            overlay.width * zoom,
            overlay.height * zoom,
          );
        }}
        onCommand={(command) => {
          onCommand?.(overlay.key, command);
          if (command === "delete") onLeave();
        }}
      >
        {overlay.content}
      </OverlayFrame>,
    ];
  });
}
