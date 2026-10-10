import { Comment01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { Button } from "~/ui/primitives/button";
import { Popover, PopoverContent, PopoverTrigger } from "~/ui/primitives/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";
import { cn } from "~/ui/utils";
import type { DocumentComment } from "../../schema.ts";

/**
 * Every thread on the sheet, from the toolbar, as text documents list theirs:
 * open ones in sheet order, resolved ones on request. Choosing one selects
 * its cells, which opens it beside them.
 */
export function SheetCommentsList({
  threads,
  onPick,
}: {
  /** Root comments with where they sit, as A1 text, in sheet order. */
  threads: ReadonlyArray<{ root: DocumentComment; where: string; replies: number }>;
  onPick: (thread: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const unresolved = threads.filter(({ root }) => !root.resolvedAt);
  const shown = showResolved ? threads : unresolved;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="All comments"
                  className="text-muted-foreground"
                  onMouseDown={(event) => event.preventDefault()}
                />
              }
            />
          }
        >
          <HugeiconsIcon icon={Comment01Icon} strokeWidth={2} />
          {unresolved.length ? <span className="tabular-nums">{unresolved.length}</span> : null}
        </TooltipTrigger>
        <TooltipContent>All comments</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-80">
        <div className="flex max-h-96 flex-col gap-1 overflow-y-auto">
          {shown.length ? (
            shown.map(({ root, where, replies }) => (
              <button
                key={root.id}
                type="button"
                className={cn(
                  "hover:bg-accent flex flex-col gap-0.5 rounded-xl px-2 py-1.5 text-left",
                  root.resolvedAt && "opacity-60",
                )}
                onClick={() => {
                  setOpen(false);
                  onPick(root.id);
                }}
              >
                <span className="text-muted-foreground text-xs">
                  {where}
                  {replies ? ` · ${replies} ${replies === 1 ? "reply" : "replies"}` : ""}
                  {root.resolvedAt ? " · Resolved" : ""}
                </span>
                <span className="line-clamp-2 text-sm">{root.body}</span>
              </button>
            ))
          ) : (
            <p className="text-muted-foreground px-2 py-1.5 text-sm">No open comments</p>
          )}
          {threads.length > unresolved.length ? (
            <Button size="sm" variant="ghost" onClick={() => setShowResolved(!showResolved)}>
              {showResolved ? "Hide resolved" : "Show resolved"}
            </Button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
