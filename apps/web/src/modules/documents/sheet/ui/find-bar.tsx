import { ArrowDown01Icon, ArrowUp01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "~/ui/primitives/button";
import { Input } from "~/ui/primitives/input";

/** Find's row under the formula bar: the query, which match is current of how many, and steps. */
export function FindBar({
  query,
  index,
  count,
  onQuery,
  onGo,
  onClose,
}: {
  query: string;
  index: number;
  count: number;
  onQuery: (query: string) => void;
  /** Moves to a match by its position, which may run past either end. */
  onGo: (index: number) => void;
  onClose: () => void;
}) {
  return (
    <div className="border-border flex h-9 shrink-0 items-center gap-1 border-b px-3">
      <Input
        autoFocus
        aria-label="Find in sheet"
        placeholder="Find in sheet"
        value={query}
        // oxlint-disable-next-line shadcn/no-restyle -- sits flat in its row, as the formula bar does.
        className="h-7 border-0 text-xs shadow-none focus-visible:ring-0"
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onGo(index + (event.shiftKey ? -1 : 1));
          } else if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      />
      <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
        {query.trim()
          ? count
            ? `${Math.min(index, count - 1) + 1} of ${count}`
            : "No matches"
          : ""}
      </span>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Previous match"
        disabled={!count}
        onClick={() => onGo(index - 1)}
      >
        <HugeiconsIcon icon={ArrowUp01Icon} strokeWidth={2} />
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Next match"
        disabled={!count}
        onClick={() => onGo(index + 1)}
      >
        <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} />
      </Button>
      <Button size="icon-xs" variant="ghost" aria-label="Close find" onClick={onClose}>
        <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
      </Button>
    </div>
  );
}
