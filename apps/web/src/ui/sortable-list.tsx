import { RestrictToVerticalAxis } from "@dnd-kit/abstract/modifiers";
import { RestrictToElement } from "@dnd-kit/dom/modifiers";
import { DragDropProvider } from "@dnd-kit/react";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import { ArrowDown01Icon, ArrowUp01Icon, DragDropVerticalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import { Button } from "~/ui/primitives/button";
import { cn } from "~/ui/utils";
import { m } from "~/paraglide/messages.js";

// Up and down only, and never past either end of the list.
const MODIFIERS = [
  RestrictToVerticalAxis,
  RestrictToElement.configure({
    element: (operation) => operation.source?.element?.closest("[data-sortable-list]") ?? null,
  }),
];

/**
 * An ordered list people rearrange by dragging a row's handle, or from the
 * keyboard: Space on the handle picks the row up, arrows move it, Space drops
 * it. Rows also carry up and down buttons. `onMove` gets the indexes before
 * and after; the caller owns the order and saves it.
 */
export function SortableList({
  onMove,
  className,
  children,
}: {
  onMove: (from: number, to: number) => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <DragDropProvider
      modifiers={MODIFIERS}
      onDragEnd={(event) => {
        const { source } = event.operation;
        if (event.canceled || !isSortable(source)) return;
        if (source.index !== source.initialIndex) onMove(source.initialIndex, source.index);
      }}
    >
      <ol data-sortable-list="" className={className}>
        {children}
      </ol>
    </DragDropProvider>
  );
}

const HandleContext = createContext<((element: Element | null) => void) | null>(null);

/** One row; only its SortableHandle starts a drag, so the row's own buttons keep their presses. */
export function SortableItem({
  id,
  index,
  className,
  children,
}: {
  id: string;
  index: number;
  className?: string;
  children: ReactNode;
}) {
  const { ref, handleRef, isDragging, isDropping } = useSortable({ id, index });
  return (
    <li
      ref={ref}
      // dnd-kit lifts the row out of the list's rounded clip until its drop
      // animation ends, so it stays a rounded card that whole time and settles
      // flush only once it is back inside the clip.
      className={cn(
        "bg-card transition-[border-radius,border-color,box-shadow] duration-200 ease-out motion-reduce:transition-none",
        (isDragging || isDropping) && "relative z-10 rounded-2xl border-transparent! shadow-md",
        className,
      )}
    >
      <HandleContext value={handleRef}>{children}</HandleContext>
    </li>
  );
}

/** The grip a row is dragged by. `label` names the row, since names can repeat. */
export function SortableHandle({ label }: { label: string }) {
  const handleRef = useContext(HandleContext);
  return (
    <button
      ref={handleRef}
      type="button"
      aria-label={m.ui_sortable_drag({ label })}
      className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex size-7 shrink-0 cursor-grab items-center justify-center rounded-md outline-none focus-visible:ring-2 active:cursor-grabbing"
    >
      <HugeiconsIcon icon={DragDropVerticalIcon} strokeWidth={2} className="size-4" />
    </button>
  );
}

/** Up and down for a row, the same move a drag makes. */
export function SortableMoveButtons({
  label,
  index,
  count,
  onMove,
}: {
  label: string;
  index: number;
  count: number;
  onMove: (from: number, to: number) => void;
}) {
  return (
    <>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={m.ui_sortable_move_up({ label })}
        disabled={index === 0}
        onClick={() => onMove(index, index - 1)}
      >
        <HugeiconsIcon icon={ArrowUp01Icon} strokeWidth={2} />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={m.ui_sortable_move_down({ label })}
        disabled={index === count - 1}
        onClick={() => onMove(index, index + 1)}
      >
        <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} />
      </Button>
    </>
  );
}
