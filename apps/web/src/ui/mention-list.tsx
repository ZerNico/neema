import { useMemo, type ReactNode } from "react";
import { Popover, PopoverContent } from "~/ui/primitives/popover";
import { cn } from "~/ui/utils";

/** One row of a mention list. Both lines are optional; only `label` shows always. */
export interface MentionItem {
  id: string;
  label: string;
  /** Muted suffix on the label line: an owner, a count. */
  meta?: string | undefined;
  /** Second line. */
  description?: string | undefined;
  /** What the typed query filters against; defaults to label plus description. */
  search?: string | undefined;
}

/**
 * The type-ahead list a composer trigger opens, anchored to the caret. It never
 * takes focus: the caret keeps it and the typing, so opening the list moves
 * neither. Keyboard handling belongs to the editor that owns the caret.
 */
export function MentionList({
  id,
  label,
  items,
  selectedIndex,
  caretRect,
  iconFor,
  onHover,
  onPick,
  onDismiss,
}: {
  /** Prefix for the listbox and option ids the editor's aria attributes point at. */
  id: string;
  label: string;
  items: readonly MentionItem[];
  selectedIndex: number;
  caretRect: (() => DOMRect | null) | null;
  /** The mark a row leads with, the same one its tag carries once picked. */
  iconFor?: ((item: MentionItem) => ReactNode) | undefined;
  onHover: (index: number) => void;
  onPick: (index: number) => void;
  onDismiss: () => void;
}) {
  const anchor = useMemo(
    () => ({ getBoundingClientRect: () => caretRect?.() ?? new DOMRect() }),
    [caretRect],
  );
  return (
    <Popover
      open={items.length > 0}
      modal={false}
      onOpenChange={(next) => {
        if (!next) onDismiss();
      }}
    >
      <PopoverContent
        anchor={anchor}
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={12}
        initialFocus={false}
        finalFocus={false}
        role="presentation"
        className="gap-0 p-1.5"
        onPointerDown={(event) => event.preventDefault()}
      >
        <div id={`${id}-list`} role="listbox" aria-label={label}>
          {items.map((item, index) => (
            <div
              key={item.id}
              id={`${id}-${index}`}
              role="option"
              aria-selected={index === selectedIndex}
              onPointerMove={() => onHover(index)}
              onClick={() => onPick(index)}
              className={cn(
                "flex cursor-pointer items-start gap-2.5 rounded-2xl px-3 py-2",
                index === selectedIndex && "bg-accent",
              )}
            >
              {iconFor ? (
                <span className="text-muted-foreground flex h-5 shrink-0 items-center">
                  {iconFor(item)}
                </span>
              ) : null}
              <span className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {item.label}
                  {item.meta ? (
                    <span className="text-muted-foreground ml-2 text-xs">{item.meta}</span>
                  ) : null}
                </p>
                {item.description ? (
                  <p className="text-muted-foreground truncate text-xs">{item.description}</p>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
