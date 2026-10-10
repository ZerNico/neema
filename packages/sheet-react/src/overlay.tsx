import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import {
  dragPlace,
  type Drag,
  type Handle,
  type OverlayCommand,
  type OverlayPlace,
} from "./overlay-place.ts";

const HANDLES: readonly Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
/** Movement under this many pixels is a click, not a drag. */
const DRAG_START = 4;
const ARROWS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
};

export interface OverlayFrameProps {
  readonly label: string;
  readonly place: OverlayPlace;
  readonly selected: boolean;
  readonly editable: boolean;
  readonly min: { readonly width: number; readonly height: number };
  readonly onSelect: () => void;
  readonly onDeselect: () => void;
  /** A move or resize let go, with the box it ended at. */
  readonly onPlace: (place: OverlayPlace) => void;
  readonly onNudge: (rows: number, cols: number) => void;
  readonly onCommand: (command: OverlayCommand) => void;
  readonly children: ReactNode;
}

/**
 * Something laid over the cells, such as a chart. A click selects it, a drag
 * moves it, its handles resize it, and the keyboard nudges, deletes and
 * copies it. Where it lands is reported once, when let go.
 */
export function OverlayFrame({
  label,
  place,
  selected,
  editable,
  min,
  onSelect,
  onDeselect,
  onPlace,
  onNudge,
  onCommand,
  children,
}: OverlayFrameProps) {
  const frame = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  // A drag that moved must not end as a click on what lies under the pointer.
  const swallowClick = useRef(false);

  const start = (event: PointerEvent, handle: Handle | "move") => {
    // Any button selects it, so a right click opens the overlay's own menu, not a cell's.
    event.stopPropagation();
    onSelect();
    frame.current?.focus({ preventScroll: true });
    if (!editable || event.button !== 0) return;
    const [x, y] = [event.clientX, event.clientY];
    let current: Drag | null = null;
    const move = (next: globalThis.PointerEvent) => {
      const [dx, dy] = [next.clientX - x, next.clientY - y];
      if (!current && Math.hypot(dx, dy) <= DRAG_START) return;
      current = { handle, dx, dy, ratio: next.shiftKey };
      setDrag(current);
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      setDrag(null);
      if (!current) return;
      swallowClick.current = true;
      onPlace(dragPlace(place, current, min));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.target !== event.currentTarget) return;
    // Keys go to the overlay alone: typing must not start editing the cell beneath it.
    event.stopPropagation();
    const arrow = ARROWS[event.key];
    const command: OverlayCommand | null =
      event.key === "Delete" || event.key === "Backspace"
        ? "delete"
        : event.key === "Enter"
          ? "edit"
          : (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d"
            ? "duplicate"
            : null;
    if (event.key === "Escape") onDeselect();
    else if (!editable) return;
    else if (arrow) onNudge(arrow[0], arrow[1]);
    else if (command) onCommand(command);
    else return;
    event.preventDefault();
  };
  const shown = drag ? dragPlace(place, drag, min) : place;
  return (
    <div
      ref={frame}
      role="group"
      aria-label={label}
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      data-overlay-frame=""
      className={`absolute outline-none ${selected ? "z-30" : "z-20"} ${drag ? "cursor-grabbing opacity-90" : ""}`}
      style={shown}
      onPointerDown={(event) => start(event, "move")}
      onClickCapture={(event) => {
        if (!swallowClick.current) return;
        swallowClick.current = false;
        event.stopPropagation();
        event.preventDefault();
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        if (editable) onCommand("edit");
      }}
      onKeyDown={onKeyDown}
    >
      {children}
      {selected ? (
        <div
          aria-hidden
          className="border-primary pointer-events-none absolute -inset-px rounded-md border-2"
        />
      ) : null}
      {selected && editable
        ? HANDLES.map((handle) => (
            <div
              key={handle}
              aria-hidden
              data-handle={handle}
              className="bg-background border-primary absolute size-2.5 rounded-full border-2"
              style={{
                top: handle.includes("n")
                  ? -5
                  : handle.includes("s")
                    ? "calc(100% - 5px)"
                    : "calc(50% - 5px)",
                left: handle.includes("w")
                  ? -5
                  : handle.includes("e")
                    ? "calc(100% - 5px)"
                    : "calc(50% - 5px)",
                cursor: `${handle}-resize`,
              }}
              onPointerDown={(event) => start(event, handle)}
            />
          ))
        : null}
    </div>
  );
}
