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
import { desktopBuild, type FolderState } from "../client/bridge.ts";

/**
 * The chat's approval policy, held server-side; the strip is where it is
 * changed. The network level is deliberately not here: how far a command may
 * reach is a trust decision about the account, not a choice per task, so it
 * belongs in settings rather than beside the folder.
 */
export interface WorkSettingsControl {
  readonly permissionLevel: PermissionLevel;
  readonly onChange: (patch: { permissionLevel?: PermissionLevel }) => void;
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
  const { status, busy, refusal } = folder;
  // A lost folder deserves attention; none yet is just an invitation.
  const lost = status.folders.filter((item) => !item.alive);
  const attention = lost.length > 0 || refusal !== null;

  return (
    <div className="mx-3 -mt-3 flex">
      <div
        className={cn(
          "bg-muted/60 text-muted-foreground flex min-w-0 flex-1 flex-wrap items-center gap-1",
          "rounded-b-[1.375rem] border border-t-0 px-3 pt-4 pb-1.5 text-xs",
          attention && "text-foreground border-warning/50 bg-warning/10",
        )}
      >
        {status.folders.map((item) => (
          <DropdownMenu key={item.name}>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  className={cn(
                    "h-6 min-w-0 gap-1.5 px-1.5 text-xs",
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
                <DropdownMenuItem onClick={folder.choose}>Choose it again</DropdownMenuItem>
              )}
              <DropdownMenuItem variant="destructive" onClick={() => folder.detach(item.name)}>
                Detach {item.name}
              </DropdownMenuItem>
              <BuildStamp />
            </DropdownMenuContent>
          </DropdownMenu>
        ))}
        <Button
          size="sm"
          variant="ghost"
          className="text-muted-foreground hover:text-foreground h-6 gap-1.5 px-1.5 text-xs"
          disabled={busy}
          onClick={folder.choose}
        >
          <HugeiconsIcon icon={FolderAddIcon} strokeWidth={2} className="size-3.5" />
          {status.folders.length === 0 ? "Add a folder from this computer" : "Add another"}
        </Button>
        {refusal ? (
          <span role="status" className="min-w-0 truncate">
            {refusal}
          </span>
        ) : null}
        {status.folders.length > 0 ? (
          <>
            <SandboxNotice state={status.sandbox} busy={busy} onSetUp={folder.setUpSandbox} />
            {settings ? (
              <PermissionPicker
                level={settings.permissionLevel}
                onChange={(permissionLevel) => settings.onChange({ permissionLevel })}
              />
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
      <Button
        size="sm"
        variant="ghost"
        className="ml-auto h-6 gap-1.5 px-1.5 text-xs"
        disabled={busy}
        onClick={onSetUp}
      >
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
            size="sm"
            className="text-muted-foreground hover:text-foreground ml-auto h-6 min-w-0 gap-1.5 px-1.5 text-xs"
            aria-label={`Permissions: ${current.label}`}
          />
        }
      >
        <HugeiconsIcon icon={Shield01Icon} strokeWidth={2} className="size-3.5" />
        <span className="truncate">{current.label}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={level}
          onValueChange={(value) => {
            if (value === "manual" || value === "auto" || value === "skip") onChange(value);
          }}
        >
          {PERMISSION_LEVELS.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Which desktop build this is. The answer to "is it running my change?". */
function BuildStamp() {
  const build = desktopBuild();
  if (!build) return null;
  return (
    <p className="text-muted-foreground px-2 pt-1.5 pb-1 text-xs tabular-nums">
      Desktop app {build}
    </p>
  );
}
