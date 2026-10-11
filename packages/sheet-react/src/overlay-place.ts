/** An overlay's box in the grid's content pixels. */
export interface OverlayPlace {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}
export type OverlayCommand = "delete" | "duplicate" | "edit";
export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export interface Drag {
  readonly handle: Handle | "move";
  readonly dx: number;
  readonly dy: number;
  /** Shift held: a corner keeps the box's proportions. */
  readonly ratio: boolean;
}

/** Where a box goes when dragged by its body or one of its handles. */
export function dragPlace(
  place: OverlayPlace,
  drag: Drag,
  min: { readonly width: number; readonly height: number },
): OverlayPlace {
  const { dx, dy, handle } = drag;
  if (handle === "move") return { ...place, top: place.top + dy, left: place.left + dx };
  const east = handle.includes("e");
  const west = handle.includes("w");
  const south = handle.includes("s");
  const north = handle.includes("n");
  let width = place.width + (east ? dx : west ? -dx : 0);
  let height = place.height + (south ? dy : north ? -dy : 0);
  if (drag.ratio && (east || west) && (north || south)) {
    const scale = Math.max(width / place.width, height / place.height);
    width = place.width * scale;
    height = place.height * scale;
  }
  width = Math.max(min.width, width);
  height = Math.max(min.height, height);
  return {
    top: north ? place.top + place.height - height : place.top,
    left: west ? place.left + place.width - width : place.left,
    width: Math.round(width),
    height: Math.round(height),
  };
}
