import { m } from "~/paraglide/messages.js";
import {
  ArrowUpRight01Icon,
  Delete02Icon,
  Download04Icon,
  FileImportIcon,
  FolderAddIcon,
  Edit02Icon,
  File01Icon,
  Folder01Icon,
  FolderSearchIcon,
  FolderTransferIcon,
  NoInternetIcon,
  Key01Icon,
  PencilEdit02Icon,
  SearchList01Icon,
  TerminalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useState } from "react";
import type { DesktopToolActivity } from "../client/use-message-stream.ts";
import { BROWSER_ACTIVITY } from "~/modules/browser/ui/browser-activity.ts";
import { isBrowserTool, type BrowserToolName } from "~/modules/browser/tool-schema.ts";
import {
  allowsBlanket,
  type ApprovalChoice,
  type PendingKind,
} from "~/modules/desktop/client/approvals.ts";
import { deletePathsOf, stringArg as text } from "~/modules/desktop/tool-schema.ts";
import { useLocalFilePreview } from "~/modules/desktop/ui/use-local-file-preview.tsx";
import { Button } from "~/ui/primitives/button";
import { Card, CardContent } from "~/ui/card.tsx";
import { Disclosure, DisclosureContent, DisclosureTrigger } from "~/ui/disclosure.tsx";
import {
  disclosureBodyRailClassName,
  disclosureTriggerClassName,
} from "~/ui/disclosure-classes.ts";
import { cn } from "~/ui/utils";
import { ActivityChevron, ActivityFace, ActivityNote } from "./activity-face.tsx";
import { activityRowClassName } from "./activity-row.ts";

const EMPTY_ROOTS: ReadonlyArray<{ name: string; path: string }> = [];

const ICONS: Record<Exclude<DesktopToolActivity["name"], BrowserToolName>, IconSvgElement> = {
  list_folder: Folder01Icon,
  find_files: FolderSearchIcon,
  search_files: SearchList01Icon,
  read_local_file: File01Icon,
  import_local_file: FileImportIcon,
  write_local_file: PencilEdit02Icon,
  save_to_workspace: Download04Icon,
  edit_local_file: Edit02Icon,
  move_local_file: FolderTransferIcon,
  delete_local_file: Delete02Icon,
  run_command: TerminalIcon,
  request_network_access: NoInternetIcon,
  request_folder: FolderAddIcon,
  request_ssh_agent: Key01Icon,
};

const iconOf = (name: DesktopToolActivity["name"]) =>
  isBrowserTool(name) ? BROWSER_ACTIVITY[name].icon : ICONS[name];

/** The argument a reader would want to see: the path, the pattern, the command. */
const argText = (activity: DesktopToolActivity) => {
  const args = activity.args ?? {};
  if (isBrowserTool(activity.name)) return BROWSER_ACTIVITY[activity.name].arg(args);
  switch (activity.name) {
    case "run_command":
      return text(args.command);
    case "request_network_access": {
      const host = text(args.host);
      const port = typeof args.port === "number" ? args.port : 443;
      return host ? `${host}:${port}` : "";
    }
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
    case "import_local_file":
    case "write_local_file":
    case "edit_local_file":
    case "save_to_workspace":
      return text(args.path) || null;
    case "move_local_file":
      return text(args.to) || null;
    default:
      return null;
  }
};

/** Names the thing acted on, never the machinery that acted. */
/**
 * A path as a row shows it: under an attached folder, that folder's name and
 * the rest; elsewhere (the workspace, another machine) just the file's name,
 * since the end of a path is what tells files apart. Hover shows it whole.
 */
const shortPath = (path: string, roots: ReadonlyArray<{ name: string; path: string }>) => {
  let owner: { name: string; path: string } | undefined;
  for (const root of roots)
    if (path.startsWith(root.path + "/") && (!owner || root.path.length > owner.path.length))
      owner = root;
  if (owner) return `${owner.name}/${path.slice(owner.path.length + 1)}`;
  return path.split("/").findLast(Boolean) ?? path;
};

const PATH_TOOLS = new Set([
  "read_local_file",
  "import_local_file",
  "write_local_file",
  "save_to_workspace",
  "edit_local_file",
]);

/** What a call that ended without a result tried, in reader words, with its path where it names one. */
const FAILED: Partial<
  Record<
    DesktopToolActivity["name"],
    { bare: () => string; path?: (inputs: { path: string }) => string }
  >
> = {
  list_folder: { bare: m.chat_desktop_failed_list },
  find_files: { bare: m.chat_desktop_failed_find },
  search_files: { bare: m.chat_desktop_failed_search },
  read_local_file: { bare: m.chat_desktop_failed_read, path: m.chat_desktop_failed_read_path },
  import_local_file: {
    bare: m.chat_desktop_failed_import,
    path: m.chat_desktop_failed_import_path,
  },
  write_local_file: { bare: m.chat_desktop_failed_write, path: m.chat_desktop_failed_write_path },
  save_to_workspace: { bare: m.chat_desktop_failed_save, path: m.chat_desktop_failed_save_path },
  edit_local_file: { bare: m.chat_desktop_failed_edit, path: m.chat_desktop_failed_edit_path },
  move_local_file: { bare: m.chat_desktop_failed_move },
  delete_local_file: { bare: m.chat_desktop_failed_delete },
  run_command: { bare: m.chat_desktop_failed_run },
};

const runningLabel = (
  activity: DesktopToolActivity,
  roots: ReadonlyArray<{ name: string; path: string }> = [],
) => {
  if (isBrowserTool(activity.name))
    return BROWSER_ACTIVITY[activity.name].running(activity.args ?? {});
  const raw = argText(activity);
  const what = PATH_TOOLS.has(activity.name) && raw ? shortPath(raw, roots) : raw;
  if (activity.status === "error") {
    const failed = FAILED[activity.name];
    if (failed)
      return PATH_TOOLS.has(activity.name) && what && failed.path
        ? failed.path({ path: what })
        : failed.bare();
  }
  switch (activity.name) {
    case "list_folder":
      return what && what !== "."
        ? m.chat_desktop_listing_path({ path: what })
        : m.chat_desktop_listing();
    case "find_files":
      return what ? m.chat_desktop_finding_path({ path: what }) : m.chat_desktop_finding();
    case "search_files":
      return what ? m.chat_desktop_searching_path({ path: what }) : m.chat_desktop_searching();
    case "read_local_file":
      return what ? m.chat_desktop_reading_path({ path: what }) : m.chat_desktop_reading();
    case "import_local_file":
      return what ? m.chat_desktop_importing_path({ path: what }) : m.chat_desktop_importing();
    case "write_local_file":
      return what ? m.chat_desktop_writing_path({ path: what }) : m.chat_desktop_writing();
    case "save_to_workspace":
      return what ? m.chat_desktop_saving_path({ path: what }) : m.chat_desktop_saving();
    case "edit_local_file":
      return what ? m.chat_desktop_editing_path({ path: what }) : m.chat_desktop_editing();
    case "move_local_file":
      return what ? m.chat_desktop_moving_path({ path: what }) : m.chat_desktop_moving();
    case "delete_local_file": {
      const listed = deletePathsOf(activity.args);
      if (listed.length === 1) return m.chat_desktop_deleting_path({ path: listed[0]! });
      if (listed.length > 1) return m.chat_desktop_deleting_count({ count: listed.length });
      return m.chat_desktop_deleting();
    }
    case "run_command":
      return what ? m.chat_desktop_running_path({ command: what }) : m.chat_desktop_running();
    case "request_network_access":
      return what
        ? m.chat_desktop_requesting_network_to({ host: what })
        : m.chat_desktop_requesting_network();
    case "request_folder":
      return what
        ? m.chat_desktop_requesting_folder_path({ path: what })
        : m.chat_desktop_requesting_folder();
    case "request_ssh_agent":
      return m.chat_desktop_requesting_ssh();
  }
};

/**
 * Groups absolute paths under the root that owns them, so a Downloads cleanup
 * reads as `Downloads` plus short names, not fifty full paths. `roots` is the
 * attempt's folder list (name + path); a path under no known root renders in
 * full, since a receipt from an older machine is still honest that way.
 */
const groupDeletePaths = (
  paths: ReadonlyArray<string>,
  roots: ReadonlyArray<{ name: string; path: string }>,
) => {
  const grouped = new Map<string, string[]>();
  const loose: string[] = [];
  for (const path of paths) {
    // Longest first: a nested root (site and site/sub both attached) claims
    // its own paths rather than lending them to the outer one.
    let owner: { name: string; path: string } | undefined;
    for (const root of roots)
      if (
        (path === root.path || path.startsWith(root.path + "/")) &&
        (!owner || root.path.length > owner.path.length)
      )
        owner = root;
    if (owner && path !== owner.path) {
      const items = grouped.get(owner.name) ?? [];
      items.push(path.slice(owner.path.length + 1));
      grouped.set(owner.name, items);
      continue;
    }
    // No known root owns it (a receipt from another machine): fall back to the
    // first segment, which older transcripts already show as the folder name.
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
const approvalTitle = (
  activity: DesktopToolActivity,
  kind: PendingKind,
  roots: ReadonlyArray<{ name: string; path: string }>,
  machine?: string,
) => {
  if (kind === "site") return m.chat_desktop_ask_site();
  if (kind === "bind") return m.chat_computer_bind({ machine: machine ?? "" });
  if (isBrowserTool(activity.name)) return BROWSER_ACTIVITY[activity.name].ask();
  switch (kind) {
    case "read":
      return activity.name === "list_folder"
        ? m.chat_desktop_ask_list()
        : activity.name === "find_files" || activity.name === "search_files"
          ? m.chat_desktop_ask_search()
          : m.chat_desktop_ask_read();
    case "command":
      return m.chat_desktop_ask_command();
    case "network":
      return activity.args?.privateNetwork === true
        ? m.chat_desktop_ask_private_network()
        : m.chat_desktop_ask_network();
    case "delete": {
      const listed = deletePathsOf(activity.args);
      if (listed.length <= 1) return m.chat_desktop_ask_delete();
      const groups = groupDeletePaths(listed, roots);
      const only = groups.length === 1 ? groups[0] : undefined;
      return only?.folder
        ? m.chat_desktop_ask_delete_in({ count: listed.length, folder: only.folder })
        : m.chat_desktop_ask_delete_count({ count: listed.length });
    }
    default:
      return activity.name === "move_local_file"
        ? m.chat_desktop_ask_move()
        : activity.name === "write_local_file"
          ? m.chat_desktop_ask_write()
          : m.chat_desktop_ask_change();
  }
};

function DeletePathList({
  paths,
  roots,
}: {
  paths: ReadonlyArray<string>;
  roots: ReadonlyArray<{ name: string; path: string }>;
}) {
  const groups = groupDeletePaths(paths, roots);
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

/**
 * The scopes a site or a network destination takes: a site once, for this chat or for this
 * desktop; a destination for this chat or for every chat, never by a blanket grant.
 */
function ScopeChoices({
  decide,
  once,
  note,
}: {
  decide: (choice: ApprovalChoice) => void;
  once?: string;
  note: string;
}) {
  return (
    <>
      <p className="text-muted-foreground text-xs">{note}</p>
      <div className="flex flex-wrap gap-2">
        {once ? (
          <Button size="sm" onClick={() => decide("allow")}>
            {once}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant={once ? "outline" : "default"}
          onClick={() => decide("allow-chat")}
        >
          {m.chat_desktop_allow_chat()}
        </Button>
        <Button size="sm" variant="outline" onClick={() => decide("allow-always")}>
          {m.chat_desktop_allow_always()}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => decide("deny")}>
          {m.chat_desktop_deny()}
        </Button>
      </div>
    </>
  );
}

const blanketLabel = (kind: PendingKind) =>
  kind === "command"
    ? m.chat_desktop_blanket_command()
    : kind === "browser-action"
      ? m.chat_desktop_blanket_browser()
      : m.chat_desktop_blanket_files();

export interface DesktopApprovalRequest {
  readonly kind: PendingKind;
  /** For `bind`: the machine the chat's computer would run on. */
  readonly machine?: string | undefined;
  /** The live call's arguments, which may hold what the transcript never stores. */
  readonly args?: Readonly<Record<string, unknown>> | null;
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
  roots,
}: {
  activity: DesktopToolActivity;
  approval: DesktopApprovalRequest;
  roots: ReadonlyArray<{ name: string; path: string }>;
}) {
  const listed = activity.name === "delete_local_file" ? deletePathsOf(activity.args) : [];
  // A site question may come from a click: the address is what is asked about.
  const what =
    approval.kind === "site"
      ? text(activity.args?.url)
      : listed.length > 1
        ? ""
        : argText(activity);
  return (
    // Same rhythm as the clarification card: py-4 on the shell, px-4 inside.
    <Card className="mb-3 gap-0 py-4">
      <CardContent className="flex min-w-0 flex-col gap-3 px-4">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <HugeiconsIcon
            icon={iconOf(activity.name)}
            strokeWidth={2}
            className="size-4 shrink-0"
            aria-hidden
          />
          <span className="min-w-0 truncate">
            {approvalTitle(activity, approval.kind, roots, approval.machine)}
          </span>
        </div>
        {approval.kind === "bind" ? (
          <p className="text-muted-foreground text-xs">{m.chat_computer_bind_note()}</p>
        ) : listed.length > 1 ? (
          <DeletePathList paths={listed} roots={roots} />
        ) : what ? (
          <pre className="bg-muted max-h-48 min-w-0 max-w-full overflow-auto rounded-xl p-2 text-xs break-all whitespace-pre-wrap">
            {what}
          </pre>
        ) : null}
        {approval.kind === "site" ? (
          <ScopeChoices
            decide={approval.decide}
            once={m.chat_desktop_allow_once()}
            note={m.chat_desktop_always_note()}
          />
        ) : approval.kind === "network" ? (
          <ScopeChoices decide={approval.decide} note={m.chat_computer_network_note()} />
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => approval.decide("allow")}>
              {m.chat_desktop_allow()}
            </Button>
            <Button size="sm" variant="outline" onClick={() => approval.decide("deny")}>
              {m.chat_desktop_deny()}
            </Button>
            {/* Deletes and network destinations are always asked about individually. */}
            {allowsBlanket(approval.kind) ? (
              <Button size="sm" variant="ghost" onClick={() => approval.decide("allow-rest")}>
                {blanketLabel(approval.kind)}
              </Button>
            ) : null}
          </div>
        )}
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
  roots = EMPTY_ROOTS,
}: {
  activity: DesktopToolActivity;
  approval?: DesktopApprovalRequest | undefined;
  /** The attempt's folders (name + path), so delete lists group by owner. */
  roots?: ReadonlyArray<{ name: string; path: string }> | undefined;
}) {
  const running = activity.status === "running";
  const failed = activity.status === "error";
  const [open, setOpen] = useState(false);
  // Null in a browser, which is what keeps a Work chat readable there without
  // offering a machine it cannot reach. Nothing is read until this is called.
  const preview = useLocalFilePreview(previewablePath(activity));
  if (running && approval)
    return (
      <ApprovalCard
        activity={approval.args ? { ...activity, args: { ...approval.args } } : activity}
        approval={approval}
        roots={roots}
      />
    );
  // A browser result's detail is written for the model (tab handles, outlines,
  // what to call next); its line already says what happened to the page.
  const detail = isBrowserTool(activity.name) ? "" : (activity.result?.detail ?? "");
  const violations = activity.result?.violations ?? [];
  const label = activity.result?.summary ?? runningLabel(activity, roots);
  const fullPath = PATH_TOOLS.has(activity.name) ? argText(activity) : "";

  // A command or a long path must never widen the column: the row truncates
  // and the body wraps, so the transcript stays as wide as the chat.
  const face = (
    <ActivityFace
      icon={iconOf(activity.name)}
      label={label}
      status={running ? "running" : failed ? "failed" : "done"}
      title={fullPath || undefined}
    />
  );

  // A file to look at makes the row one target that opens it, marked as
  // opening something rather than unfolding: what the call did is the file.
  if (preview)
    return (
      <>
        <button
          type="button"
          onClick={preview.open}
          className={cn(disclosureTriggerClassName, "mb-2")}
        >
          {face}
          <HugeiconsIcon
            icon={ArrowUpRight01Icon}
            strokeWidth={2}
            className="size-3.5 shrink-0"
            aria-hidden
          />
        </button>
        {preview.dialog}
        {violations.length ? (
          <div className="-mt-1 mb-2 pl-6">
            <ActivityNote>{violations.join(" ")}</ActivityNote>
          </div>
        ) : null}
      </>
    );

  if (running || detail.length === 0)
    return <div className={cn(activityRowClassName, "mb-2")}>{face}</div>;

  return (
    <Disclosure open={open} onOpenChange={setOpen} className="mb-2 min-w-0 max-w-full">
      <DisclosureTrigger className={disclosureTriggerClassName}>
        {face}
        <ActivityChevron open={open} />
      </DisclosureTrigger>
      <DisclosureContent>
        <div className={cn(disclosureBodyRailClassName, "flex min-w-0 flex-col gap-2")}>
          {violations.length > 0 ? (
            <p className="text-warning text-xs">{violations.join("\n")}</p>
          ) : null}
          <pre className="bg-muted max-h-64 min-w-0 max-w-full overflow-auto rounded-xl p-2 text-xs break-all whitespace-pre-wrap">
            {detail}
          </pre>
          {activity.result?.truncated ? (
            <p className="text-muted-foreground text-xs">{m.chat_desktop_shortened()}</p>
          ) : null}
        </div>
      </DisclosureContent>
    </Disclosure>
  );
}
