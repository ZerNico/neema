import {
  ArrowDown01Icon,
  Delete02Icon,
  Edit02Icon,
  File01Icon,
  Folder01Icon,
  FolderSearchIcon,
  FolderTransferIcon,
  PencilEdit02Icon,
  SearchList01Icon,
  TerminalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useState } from "react";
import type { DesktopToolActivity } from "../client/use-message-stream.ts";
import type { ApprovalChoice, PendingKind } from "~/modules/desktop/client/approvals.ts";
import { deletePathsOf } from "~/modules/desktop/tool-schema.ts";
import { useLocalFilePreview } from "~/modules/desktop/ui/local-file-preview.tsx";
import { Button } from "~/ui/primitives/button";
import { Card, CardContent } from "~/ui/card.tsx";
import {
  Disclosure,
  DisclosureContent,
  DisclosureTrigger,
  disclosureBodyRailClassName,
  disclosureChevronMotionClassName,
  disclosureTriggerClassName,
} from "~/ui/disclosure.tsx";
import { cn } from "~/ui/utils";
import { activityRowClassName } from "./activity-row.ts";

const ICONS: Record<DesktopToolActivity["name"], IconSvgElement> = {
  list_folder: Folder01Icon,
  find_files: FolderSearchIcon,
  search_files: SearchList01Icon,
  read_local_file: File01Icon,
  write_local_file: PencilEdit02Icon,
  edit_local_file: Edit02Icon,
  move_local_file: FolderTransferIcon,
  delete_local_file: Delete02Icon,
  run_command: TerminalIcon,
};

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** The argument a reader would want to see: the path, the pattern, the command. */
const argText = (activity: DesktopToolActivity) => {
  const args = activity.args ?? {};
  switch (activity.name) {
    case "run_command":
      return text(args.folder) ? `${text(args.folder)}: ${text(args.command)}` : text(args.command);
    case "find_files":
    case "search_files":
      return text(args.pattern);
    case "move_local_file":
      return text(args.from) && text(args.to) ? `${text(args.from)} → ${text(args.to)}` : "";
    case "delete_local_file":
      return deletePathsOf(args).join("\n");
    default:
      return text(args.path);
  }
};

/**
 * The file a finished row leaves behind, when there is one to look at. A move
 * names its destination: the source is the path that no longer exists.
 */
const previewablePath = (activity: DesktopToolActivity): string | null => {
  if (activity.status !== "complete") return null;
  const args = activity.args ?? {};
  switch (activity.name) {
    case "read_local_file":
    case "write_local_file":
    case "edit_local_file":
      return text(args.path) || null;
    case "move_local_file":
      return text(args.to) || null;
    default:
      return null;
  }
};

/** Names the thing acted on, never the machinery that acted. */
const runningLabel = (activity: DesktopToolActivity) => {
  const what = argText(activity);
  switch (activity.name) {
    case "list_folder":
      return what && what !== "." ? `Listing ${what}` : "Listing the folder";
    case "find_files":
      return what ? `Finding ${what}` : "Finding files";
    case "search_files":
      return what ? `Searching for ${what}` : "Searching files";
    case "read_local_file":
      return what ? `Reading ${what}` : "Reading a file";
    case "write_local_file":
      return what ? `Writing ${what}` : "Writing a file";
    case "edit_local_file":
      return what ? `Editing ${what}` : "Editing a file";
    case "move_local_file":
      return what ? `Moving ${what}` : "Moving a file";
    case "delete_local_file": {
      const listed = deletePathsOf(activity.args);
      if (listed.length === 1) return `Deleting ${listed[0]}`;
      if (listed.length > 1) return `Deleting ${listed.length} files`;
      return "Deleting files";
    }
    case "run_command":
      return what ? `Running ${what}` : "Running a command";
  }
};

/** First-segment groups so a Downloads cleanup is names, not fifty full paths. */
const groupDeletePaths = (paths: ReadonlyArray<string>) => {
  const grouped = new Map<string, string[]>();
  const loose: string[] = [];
  for (const path of paths) {
    const slash = path.indexOf("/");
    if (slash <= 0) {
      loose.push(path);
      continue;
    }
    const folder = path.slice(0, slash);
    const rest = path.slice(slash + 1);
    const items = grouped.get(folder) ?? [];
    items.push(rest === "" ? path : rest);
    grouped.set(folder, items);
  }
  const groups: { folder: string | null; items: string[] }[] = [...grouped].map(
    ([folder, items]) => ({ folder, items }),
  );
  if (loose.length > 0) groups.push({ folder: null, items: loose });
  return groups;
};

/** What the reader is being asked to allow, in their words. */
const approvalTitle = (activity: DesktopToolActivity, kind: PendingKind) => {
  switch (kind) {
    case "read":
      return activity.name === "list_folder"
        ? "List this folder"
        : activity.name === "find_files" || activity.name === "search_files"
          ? "Search this computer"
          : "Read this file";
    case "command":
      return "Run on this computer";
    case "delete": {
      const listed = deletePathsOf(activity.args);
      if (listed.length <= 1) return "Delete from this computer";
      const groups = groupDeletePaths(listed);
      const only = groups.length === 1 ? groups[0] : undefined;
      return only?.folder
        ? `Delete ${listed.length} files in ${only.folder}`
        : `Delete ${listed.length} files from this computer`;
    }
    default:
      return activity.name === "move_local_file"
        ? "Move on this computer"
        : activity.name === "write_local_file"
          ? "Write this file"
          : "Change this file";
  }
};

function DeletePathList({ paths }: { paths: ReadonlyArray<string> }) {
  const groups = groupDeletePaths(paths);
  const folderInTitle = groups.length === 1 && groups[0]?.folder !== null;
  return (
    <div className="bg-muted max-h-64 min-w-0 max-w-full overflow-auto rounded-xl px-3 py-2 text-xs">
      <div className="flex min-w-0 flex-col gap-2">
        {groups.map((group) => (
          <div key={group.folder ?? ""} className="min-w-0">
            {!folderInTitle && group.folder ? (
              <p className="text-muted-foreground mb-1">{group.folder}</p>
            ) : null}
            <ul className="space-y-1">
              {group.items.map((item) => (
                <li
                  key={`${group.folder ?? ""}/${item}`}
                  className="min-w-0 [overflow-wrap:anywhere]"
                >
                  {item}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

const blanketLabel = (kind: PendingKind) =>
  kind === "command" ? "Allow commands for this chat" : "Allow edits for this chat";

export interface DesktopApprovalRequest {
  readonly kind: PendingKind;
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
  const listed = activity.name === "delete_local_file" ? deletePathsOf(activity.args) : [];
  const what = listed.length > 1 ? "" : argText(activity);
  return (
    // Same rhythm as the clarification card: py-4 on the shell, px-4 inside.
    <Card className="mb-3 gap-0 py-4">
      <CardContent className="flex min-w-0 flex-col gap-3 px-4">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <HugeiconsIcon
            icon={ICONS[activity.name]}
            strokeWidth={2}
            className="size-4 shrink-0"
            aria-hidden
          />
          <span className="min-w-0 truncate">{approvalTitle(activity, approval.kind)}</span>
        </div>
        {listed.length > 1 ? (
          <DeletePathList paths={listed} />
        ) : what ? (
          <pre className="bg-muted max-h-48 min-w-0 max-w-full overflow-auto rounded-xl p-2 text-xs break-all whitespace-pre-wrap">
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
          {/* A delete is asked about every time; there is no blanket for it.
              A read is only asked under "ask each time", which is the blanket. */}
          {approval.kind !== "delete" && approval.kind !== "read" ? (
            <Button size="sm" variant="ghost" onClick={() => approval.decide("allow-rest")}>
              {blanketLabel(approval.kind)}
            </Button>
          ) : null}
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
  // Null in a browser, which is what keeps a Work chat readable there without
  // offering a machine it cannot reach. Nothing is read until this is called.
  const preview = useLocalFilePreview(previewablePath(activity));
  if (running && approval) return <ApprovalCard activity={activity} approval={approval} />;
  const detail = activity.result?.detail ?? "";
  const violations = activity.result?.violations ?? [];
  const label = activity.result?.summary ?? runningLabel(activity);

  // A command or a long path must never widen the column: the row truncates
  // and the body wraps, so the transcript stays as wide as the chat.
  const face = (
    <>
      <HugeiconsIcon
        icon={ICONS[activity.name]}
        strokeWidth={2}
        className="size-4 shrink-0"
        aria-hidden
      />
      <span className={cn("min-w-0 truncate", running && "text-shimmer")}>{label}</span>
    </>
  );

  if (running || detail.length === 0) {
    return preview ? (
      <>
        <button
          type="button"
          onClick={preview.open}
          className={cn(
            disclosureTriggerClassName,
            "mb-2 min-w-0 max-w-full text-left",
            failed && "text-destructive",
          )}
        >
          {face}
        </button>
        {preview.dialog}
      </>
    ) : (
      <div
        className={cn(
          activityRowClassName,
          "mb-2 min-w-0 max-w-full",
          failed && "text-destructive",
        )}
      >
        {face}
      </div>
    );
  }

  return (
    <Disclosure open={open} onOpenChange={setOpen} className="mb-2 min-w-0 max-w-full">
      {preview ? (
        // Two targets, because the row now answers two questions: what the file
        // holds now, and what the call did to it.
        <div
          className={cn("flex min-w-0 max-w-full items-center gap-1", failed && "text-destructive")}
        >
          <button
            type="button"
            onClick={preview.open}
            className={cn(disclosureTriggerClassName, "min-w-0 flex-1 text-left")}
          >
            {face}
          </button>
          {preview.dialog}
          <DisclosureTrigger
            className={cn(disclosureTriggerClassName, "shrink-0")}
            aria-label="Show what this call did"
          >
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              strokeWidth={2}
              className={cn(disclosureChevronMotionClassName, "size-3.5", open && "rotate-180")}
              aria-hidden
            />
          </DisclosureTrigger>
        </div>
      ) : (
        <DisclosureTrigger
          className={cn(
            disclosureTriggerClassName,
            "min-w-0 max-w-full",
            failed && "text-destructive",
          )}
        >
          {face}
        </DisclosureTrigger>
      )}
      <DisclosureContent>
        <div className={cn(disclosureBodyRailClassName, "flex min-w-0 flex-col gap-2")}>
          {violations.length > 0 ? (
            <p className="text-warning text-xs">{violations.join("\n")}</p>
          ) : null}
          <pre className="bg-muted max-h-64 min-w-0 max-w-full overflow-auto rounded-xl p-2 text-xs break-all whitespace-pre-wrap">
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
