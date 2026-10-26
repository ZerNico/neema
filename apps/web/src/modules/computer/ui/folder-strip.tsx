import { Alert01Icon, Folder01Icon, Shield01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { cn } from "~/ui/utils";
import { m } from "~/paraglide/messages.js";
import type { PermissionLevel } from "~/modules/chat/schema.ts";
import { PERMISSION_LEVELS } from "~/modules/desktop/client/approvals.ts";
import type { ComposerFolders } from "../client/use-composer-folders.ts";

/**
 * The chat's computer as it bears on the next message, in a slim strip tucked under the composer:
 * its folders, which stay with the chat rather than one message, and how much it asks first.
 * Attaching a folder is in the plus menu; each folder opens a menu to detach it, or to pick it
 * again once it has moved.
 */
export function FolderStrip({
  folders,
  disabled,
}: {
  folders: ComposerFolders;
  disabled: boolean;
}) {
  const { permission } = folders;
  if (folders.items.length === 0 && !permission) return null;
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
        {permission ? (
          <PermissionPicker level={permission.level} onChange={permission.onChange} />
        ) : null}
      </div>
    </div>
  );
}

function PermissionPicker({
  level,
  onChange,
}: {
  level: PermissionLevel;
  onChange: (level: PermissionLevel) => void;
}) {
  const current = PERMISSION_LEVELS.find((option) => option.value === level) ?? PERMISSION_LEVELS[0]!;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground hover:text-foreground ml-auto min-w-0"
            aria-label={m.computer_permission_label({ level: current.label() })}
          />
        }
      >
        <HugeiconsIcon icon={Shield01Icon} strokeWidth={2} className="size-3.5" />
        <span className="truncate">{current.label()}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72 max-w-[calc(100vw-2rem)]">
        <DropdownMenuRadioGroup
          value={level}
          onValueChange={(value) => {
            const chosen = PERMISSION_LEVELS.find((option) => option.value === value);
            if (chosen) onChange(chosen.value);
          }}
        >
          {PERMISSION_LEVELS.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              <span className="flex min-w-0 flex-col gap-1">
                <span>{option.label()}</span>
                <span className="text-muted-foreground text-xs font-normal">
                  {option.description()}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
