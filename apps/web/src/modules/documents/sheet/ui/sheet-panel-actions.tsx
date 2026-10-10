import { MoreVerticalIcon, PencilEdit02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { Button } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";
import type { EditableDocument } from "../../schema.ts";
import { RenameDocumentDialog } from "../../ui/rename-document-dialog.tsx";

/** A sheet's actions row: what a sheet can do as a whole. */
export function SheetPanelActions({ document }: { document: EditableDocument | null }) {
  const [renaming, setRenaming] = useState(false);
  if (!document?.canEdit) return null;
  return (
    <div className="flex items-center justify-end gap-0.5">
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Sheet actions"
                    className="text-muted-foreground"
                  />
                }
              />
            }
          >
            <HugeiconsIcon icon={MoreVerticalIcon} strokeWidth={2} />
          </TooltipTrigger>
          <TooltipContent>More</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem onClick={() => setRenaming(true)}>
            <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} />
            Rename
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <RenameDocumentDialog document={document} open={renaming} onOpenChange={setRenaming} />
    </div>
  );
}
