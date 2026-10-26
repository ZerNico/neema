import { Alert01Icon, Folder01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { cn } from "~/ui/utils";
import { m } from "~/paraglide/messages.js";
import type { ComposerFolders } from "../client/use-composer-folders.ts";

/**
 * The chat's attached folders, in a slim strip tucked under the composer. Folders stay with the
 * chat rather than going with one message, so they live here and not among the message's file
 * chips. Attaching one is in the plus menu; each folder opens a menu to detach it, or to pick
 * it again once it has moved.
 */
export function FolderStrip({
  folders,
  disabled,
}: {
  folders: ComposerFolders;
  disabled: boolean;
}) {
  if (folders.items.length === 0) return null;
  // A moved folder deserves attention; the others are just there.
  const lost = folders.items.some((folder) => !folder.alive);
  return (
    <div className="mx-3 -mt-3 flex">
      <div
        className={cn(
          "bg-muted/60 text-muted-foreground flex min-w-0 flex-1 flex-wrap items-center gap-1",
          "rounded-b-composer border border-t-0 px-3 pt-4 pb-1.5 text-xs",
          lost && "text-foreground border-warning/50 bg-warning/10",
        )}
      >
        {folders.items.map((folder) => (
          <DropdownMenu key={folder.name}>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={disabled || folders.busy}
                  className={cn(
                    "min-w-0",
                    folder.alive && "text-muted-foreground hover:text-foreground",
                  )}
                  title={folder.alive ? undefined : m.computer_folder_lost()}
                />
              }
            >
              <HugeiconsIcon
                icon={folder.alive ? Folder01Icon : Alert01Icon}
                strokeWidth={2}
                className="size-3.5"
              />
              <span className="truncate">{folder.name}</span>
              {folder.readOnly ? (
                <span className="text-muted-foreground">· {m.computer_folder_read_only()}</span>
              ) : null}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {folder.alive ? null : (
                <DropdownMenuItem onClick={() => folders.onChooseAgain(folder.name)}>
                  {m.computer_folder_choose_again()}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem variant="destructive" onClick={() => folders.onRemove(folder.name)}>
                {m.computer_folder_detach({ name: folder.name })}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ))}
      </div>
    </div>
  );
}
