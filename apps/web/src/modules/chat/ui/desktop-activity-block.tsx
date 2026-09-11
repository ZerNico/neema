import {
  Folder01Icon,
  TerminalIcon,
  File01Icon,
  PencilEdit02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import type { DesktopToolActivity } from "../client/use-message-stream.ts";
import type { ApprovalChoice, ApprovalKind } from "~/modules/desktop/client/approvals.ts";
import { Button } from "~/ui/primitives/button";
import { Card, CardContent } from "~/ui/card.tsx";
import {
  Disclosure,
  DisclosureContent,
  DisclosureTrigger,
  disclosureBodyRailClassName,
  disclosureTriggerClassName,
} from "~/ui/disclosure.tsx";
import { cn } from "~/ui/utils";
import { activityRowClassName } from "./activity-row.ts";

const ICONS = {
  list_folder: Folder01Icon,
  read_local_file: File01Icon,
  write_local_file: PencilEdit02Icon,
  run_command: TerminalIcon,
} as const;

const argText = (activity: DesktopToolActivity) => {
  const args = activity.args ?? {};
  const value = activity.name === "run_command" ? args.command : args.path;
  return typeof value === "string" ? value : "";
};

/** Names the thing acted on, never the machinery that acted. */
const runningLabel = (activity: DesktopToolActivity) => {
  const what = argText(activity);
  switch (activity.name) {
    case "list_folder":
      return what && what !== "." ? `Listing ${what}` : "Listing the folder";
    case "read_local_file":
      return what ? `Reading ${what}` : "Reading a file";
    case "write_local_file":
      return what ? `Writing ${what}` : "Writing a file";
    case "run_command":
      return what ? `Running ${what}` : "Running a command";
  }
};

export interface DesktopApprovalRequest {
  readonly kind: ApprovalKind;
  readonly decide: (choice: ApprovalChoice) => void;
}

/**
 * Asks before the machine is changed.
 *
 * Unlike the clarification card this one is pressable while the message is
 * still streaming, because the generation is parked on the answer rather than
 * finished by it. Nothing has happened yet when this renders: the page holds
 * the call, so declining means the work is simply never done.
 */
function ApprovalCard({
  activity,
  approval,
}: {
  activity: DesktopToolActivity;
  approval: DesktopApprovalRequest;
}) {
  const what = argText(activity);
  return (
    <Card className="mb-2">
      <CardContent className="flex flex-col gap-3 px-4">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <HugeiconsIcon
            icon={ICONS[activity.name]}
            strokeWidth={2}
            className="size-4 shrink-0"
            aria-hidden
          />
          <span className="min-w-0 truncate">
            {approval.kind === "command" ? "Run on this computer" : "Change this file"}
          </span>
        </div>
        {what ? (
          <pre className="bg-muted overflow-x-auto rounded-xl p-2 text-xs whitespace-pre-wrap">
            {what}
          </pre>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => approval.decide("allow")}>
            Allow
          </Button>
          <Button size="sm" variant="outline" onClick={() => approval.decide("deny")}>
            Deny
          </Button>
          <Button size="sm" variant="ghost" onClick={() => approval.decide("allow-rest")}>
            {approval.kind === "command"
              ? "Allow commands for this chat"
              : "Allow edits for this chat"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * One row per call on the user's machine, with the detail behind a disclosure.
 * The summary comes from the machine, since it is the only side that knows what
 * actually happened; while the call is in flight the arguments are all there is.
 */
export function DesktopActivityBlock({
  activity,
  approval,
}: {
  activity: DesktopToolActivity;
  approval?: DesktopApprovalRequest | undefined;
}) {
  const running = activity.status === "running";
  const failed = activity.status === "error";
  const [open, setOpen] = useState(false);
  if (running && approval) return <ApprovalCard activity={activity} approval={approval} />;
  const detail = activity.result?.detail ?? "";
  const violations = activity.result?.violations ?? [];
  const label = activity.result?.summary ?? runningLabel(activity);

  if (running || detail.length === 0) {
    return (
      <div className={cn(activityRowClassName, "mb-2", failed && "text-destructive")}>
        <HugeiconsIcon icon={ICONS[activity.name]} strokeWidth={2} className="size-4" aria-hidden />
        <span className={cn("min-w-0 truncate", running && "text-shimmer")}>{label}</span>
      </div>
    );
  }

  return (
    <Disclosure open={open} onOpenChange={setOpen} className="mb-2">
      <DisclosureTrigger className={cn(disclosureTriggerClassName, failed && "text-destructive")}>
        <HugeiconsIcon icon={ICONS[activity.name]} strokeWidth={2} className="size-4" aria-hidden />
        <span className="min-w-0 truncate">{label}</span>
      </DisclosureTrigger>
      <DisclosureContent>
        <div className={cn(disclosureBodyRailClassName, "flex flex-col gap-2")}>
          {violations.length > 0 ? (
            <p className="text-warning text-xs">{violations.join("\n")}</p>
          ) : null}
          <pre className="bg-muted max-h-64 overflow-auto rounded-xl p-2 text-xs whitespace-pre-wrap">
            {detail}
          </pre>
          {activity.result?.truncated ? (
            <p className="text-muted-foreground text-xs">Shortened to fit.</p>
          ) : null}
        </div>
      </DisclosureContent>
    </Disclosure>
  );
}
