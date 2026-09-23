import { Alert01Icon, Folder01Icon, FolderAddIcon, Shield01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { SandboxAvailability } from "@chat/desktop-rpc";
import type { PermissionLevel } from "~/modules/chat/schema.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { Button } from "~/ui/primitives/button";
import { cn } from "~/ui/utils";
import { PERMISSION_LEVELS } from "../client/approvals.ts";
import type { FolderState } from "../client/bridge.ts";

/** The chat's approval policy, held server-side; the strip is where it is changed. */
export interface WorkSettingsControl {
  readonly permissionLevel: PermissionLevel;
  readonly onChange: (level: PermissionLevel) => void;
}

/**
 * A slim strip tucked under the composer, slightly narrower so it reads as
 * belonging to it while sitting behind it.
 *
 * It is the one place folder state lives: the attached folder, the prompt to
 * pick one when the mapping cannot be resolved, and the one-time sandbox setup.
 * Splitting those across a control and a banner would mean keeping two surfaces
 * consistent about the same thing.
 *
 * Shown only for a work chat inside the desktop app; the composer owns that
 * decision and the folder state, so the two never disagree about whether a
 * send is possible.
 */
export function FolderStrip({
  folder,
  settings,
}: {
  folder: FolderState;
  /** Absent before the conversation exists: there is nothing to govern yet. */
  settings?: WorkSettingsControl | undefined;
}) {
  if (folder.readiness !== "ready") {
    return (
      <div className="bg-muted/60 text-muted-foreground mx-3 -mt-3 flex items-center gap-2 rounded-b-composer border border-t-0 px-3 pt-4 pb-1.5 text-xs">
        <span role="status" className="flex min-h-6 items-center">
          {folder.readiness === "loading" ? "Checking folders…" : "Could not check folders."}
        </span>
        {folder.readiness === "error" ? (
          <Button size="xs" variant="ghost" onClick={folder.refresh} disabled={folder.busy}>
            Retry folder check
          </Button>
        ) : null}
      </div>
    );
  }
  const { status, busy, refusal } = folder;
  // A lost folder deserves attention; none yet is just an invitation.
  const lost = status.folders.filter((item) => !item.alive);
  const attention = lost.length > 0 || refusal !== null;

  return (
    <div className="mx-3 -mt-3 flex">
      <div
        className={cn(
          "bg-muted/60 text-muted-foreground flex min-w-0 flex-1 flex-wrap items-center gap-1",
          "rounded-b-composer border border-t-0 px-3 pt-4 pb-1.5 text-xs",
          attention && "text-foreground border-warning/50 bg-warning/10",
        )}
      >
        {/* The workspace is app-managed and needs no chip: it is always there,
            so only the folders the user chose are worth showing. */}
        {status.folders.map((item) => (
          <DropdownMenu key={item.name}>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={busy}
                  className={cn(
                    "min-w-0",
                    item.alive && "text-muted-foreground hover:text-foreground",
                  )}
                  title={item.alive ? undefined : "This folder is no longer where it was."}
                />
              }
            >
              <HugeiconsIcon
                icon={item.alive ? Folder01Icon : Alert01Icon}
                strokeWidth={2}
                className="size-3.5"
              />
              <span className="truncate">{item.name}</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {item.alive ? null : (
                <DropdownMenuItem onClick={() => folder.choose(item.name)}>
                  Choose it again
                </DropdownMenuItem>
              )}
              <DropdownMenuItem variant="destructive" onClick={() => folder.detach(item.name)}>
                Detach {item.name}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ))}
        <Button
          size="xs"
          variant="ghost"
          className="text-muted-foreground hover:text-foreground"
          disabled={busy}
          onClick={() => folder.choose()}
        >
          <HugeiconsIcon icon={FolderAddIcon} strokeWidth={2} className="size-3.5" />
          {status.folders.length === 0 ? "Add a folder from this computer" : "Add another"}
        </Button>
        {refusal ? (
          <span role="status" className="min-w-0 truncate">
            {refusal}
          </span>
        ) : null}
        {status.folders.length > 0 || status.workspace ? (
          <>
            <SandboxNotice state={status.sandbox} busy={busy} onSetUp={folder.setUpSandbox} />
            {settings ? (
              <PermissionPicker level={settings.permissionLevel} onChange={settings.onChange} />
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Files work without the sandbox; only commands need it. So this never blocks
 * the folder, it just says what is missing and, on Windows, offers to fix it.
 */
function SandboxNotice({
  state,
  busy,
  onSetUp,
}: {
  state: SandboxAvailability;
  busy: boolean;
  onSetUp: () => void;
}) {
  if (state.kind === "ready") return null;
  if (state.kind === "setup-needed") {
    return (
      <Button size="xs" variant="ghost" className="ml-auto" disabled={busy} onClick={onSetUp}>
        Commands need a one-time setup
      </Button>
    );
  }
  return (
    <span
      className="ml-auto truncate"
      title={state.kind === "missing-deps" ? state.hint : state.reason}
    >
      {state.kind === "missing-deps" ? "Commands unavailable" : "Commands not supported here"}
    </span>
  );
}

/**
 * How much this chat asks before acting. Lives in the strip because it is a
 * property of the folder relationship, not of the composer: the same setting
 * a reader would look for beside the folder name.
 */
function PermissionPicker({
  level,
  onChange,
}: {
  level: PermissionLevel;
  onChange: (level: PermissionLevel) => void;
}) {
  const current = PERMISSION_LEVELS.find((option) => option.value === level)!;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground hover:text-foreground ml-auto min-w-0"
            aria-label={`Permissions: ${current.label}`}
          />
        }
      >
        <HugeiconsIcon icon={Shield01Icon} strokeWidth={2} className="size-3.5" />
        <span className="truncate">{current.label}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 max-w-[calc(100vw-2rem)]">
        <DropdownMenuRadioGroup
          value={level}
          onValueChange={(value) => {
            if (value === "manual" || value === "auto" || value === "skip") onChange(value);
          }}
        >
          {PERMISSION_LEVELS.map((option) => (
            <DropdownMenuRadioItem
              key={option.value}
              value={option.value}
              aria-label={option.label}
              aria-describedby={`permission-${option.value}-description`}
            >
              <span className="flex min-w-0 flex-col gap-1">
                <span>{option.label}</span>
                <span
                  id={`permission-${option.value}-description`}
                  className="text-muted-foreground text-xs font-normal"
                >
                  {option.description}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <p className="text-muted-foreground px-3 py-2 text-xs">
          The delete tool always asks, once for the whole list. An allowed command can still delete
          files.
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
