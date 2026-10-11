import { Download04Icon, MoreVerticalIcon, PencilEdit02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { Button } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";
import type { EditableDocument } from "../../schema.ts";
import { RenameDocumentDialog } from "../../ui/rename-document-dialog.tsx";

/** A sheet's actions row: the slot the body puts its ribbon in, menu included. */
export function SheetPanelActions({
  document,
  toolbarSlot,
}: {
  document: EditableDocument | null;
  /** Receives the element the sheet puts its formatting controls in. */
  toolbarSlot: (element: HTMLElement | null) => void;
}) {
  if (!document) return null;
  return <div ref={toolbarSlot} className="flex min-w-0 flex-1" />;
}

/** The sheet's own menu, drawn by the ribbon beside its comment buttons. */
export function SheetMenu({
  document,
  onDownloadCsv,
}: {
  document: EditableDocument | null;
  /** The open sheet's values, as the page has calculated them. */
  onDownloadCsv: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  if (!document) return null;
  return (
    <>
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
          {document.canEdit ? (
            <>
              <DropdownMenuItem onClick={() => setRenaming(true)}>
                <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} />
                Rename
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          ) : null}
          {/* The server builds the file from the stored sheet and sends it as a download. */}
          <DropdownMenuItem
            onClick={() => {
              window.location.assign(`/api/sheets/${encodeURIComponent(document.id)}/export`);
            }}
          >
            <HugeiconsIcon icon={Download04Icon} strokeWidth={2} />
            Download as Excel
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onDownloadCsv}>
            <HugeiconsIcon icon={Download04Icon} strokeWidth={2} />
            Download sheet as CSV
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {document.canEdit ? (
        <RenameDocumentDialog document={document} open={renaming} onOpenChange={setRenaming} />
      ) : null}
    </>
  );
}
