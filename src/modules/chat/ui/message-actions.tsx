import { BookOpen01Icon, MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ToolSource } from "../client/use-message-stream.ts";
import { useSourcesPanel } from "./sources-panel.tsx";
import { Button } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";

// The action row under a finished assistant message. Currently one entry —
// copy/regenerate belong here too, this just establishes the surface.
//
// Only rendered for completed messages, which is what makes it safe to hand the
// panel a snapshot of `sources` (see the body-props contract in detail-panel).
export function MessageActions({
  messageId,
  sources,
}: {
  messageId: string;
  sources: ToolSource[];
}) {
  const openSources = useSourcesPanel(messageId, sources);
  if (sources.length === 0) return null;

  return (
    <div className="mt-2 flex items-center gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Message actions"
              className="text-muted-foreground"
            />
          }
        >
          <HugeiconsIcon icon={MoreHorizontalIcon} className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={() => openSources()}>
            <HugeiconsIcon icon={BookOpen01Icon} className="size-4" />
            View sources ({sources.length})
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
