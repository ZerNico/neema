import { Alert01Icon, Folder01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { SandboxAvailability } from "@chat/desktop-rpc";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { Button } from "~/ui/primitives/button";
import { cn } from "~/ui/utils";
import type { FolderState } from "../client/bridge.ts";

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
export function FolderStrip({ folder }: { folder: FolderState }) {
  const { status, busy } = folder;
  // No folder is the same problem as a lost one: nothing to work on yet.
  const attention = status.kind !== "attached";

  return (
    <div className="mx-3 -mt-3 flex">
      <div
        className={cn(
          "bg-muted/60 text-muted-foreground flex min-w-0 flex-1 items-center gap-1",
          "rounded-b-[1.375rem] border border-t-0 px-3 pt-4 pb-1.5 text-xs",
          attention && "text-foreground border-warning/50 bg-warning/10",
        )}
      >
        {status.kind !== "attached" ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 gap-1.5 px-1.5 text-xs"
            disabled={busy}
            onClick={folder.choose}
          >
            <HugeiconsIcon
              icon={status.kind === "unresolved" ? Alert01Icon : Folder01Icon}
              strokeWidth={2}
              className="size-3.5"
            />
            {status.kind === "unresolved" && status.name
              ? `Choose ${status.name} again to continue`
              : "Choose a folder from this computer"}
          </Button>
        ) : (
          <>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    className="text-muted-foreground hover:text-foreground h-6 min-w-0 gap-1.5 px-1.5 text-xs"
                  />
                }
              >
                <HugeiconsIcon icon={Folder01Icon} strokeWidth={2} className="size-3.5" />
                <span className="truncate">{status.name}</span>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onClick={folder.choose}>Change folder</DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onClick={folder.detach}>
                  Detach folder
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <SandboxNotice state={status.sandbox} busy={busy} onSetUp={folder.setUpSandbox} />
          </>
        )}
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
