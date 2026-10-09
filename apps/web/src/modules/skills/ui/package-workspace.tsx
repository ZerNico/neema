import {
  ArrowRight01Icon,
  Delete02Icon,
  Download01Icon,
  File01Icon,
  FileAddIcon,
  FileUploadIcon,
  Folder01Icon,
  FolderAddIcon,
  PencilEdit02Icon,
  Upload01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { markdownTableComponents } from "~/ui/markdown-components.ts";
import { lazy, Suspense, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import type { ReactNode } from "react";
import { cardSurfaceClassName } from "~/ui/card-surface.ts";
import { markdownPlugins } from "~/ui/markdown-plugins.ts";
import { Button, buttonVariants } from "~/ui/primitives/button";
import { PendingButton } from "~/ui/pending-button.tsx";
import { toastError } from "~/ui/error-toast.ts";
import { formatFileSize } from "~/modules/attachments/constants.ts";
import {
  FilePreviewBody,
  type AttachmentPreviewTarget,
} from "~/modules/attachments/ui/attachment-preview.tsx";
import { FieldError } from "~/ui/primitives/field";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";
import { useConfirm } from "~/ui/confirm-context.ts";
import { ViewToggle } from "~/ui/view-toggle.tsx";
import { useIsMobile } from "~/ui/use-mobile.ts";
import { cn } from "~/ui/utils.ts";
import {
  classifySkillFile,
  isBinarySkillFile,
  SKILL_LIMITS,
  validateSkillPath,
  type SkillBinaryFile,
  type SkillFile,
  type SkillFinding,
} from "../package.ts";
import { focusRingClassName } from "~/ui/focus-ring.ts";
import { LINK_SAFETY } from "~/ui/link-safety.tsx";

const TextEditor = lazy(() => import("./text-editor.tsx"));
const noFindings: SkillFinding[] = [];
// Diagram SVGs can contain external image references outside the Markdown img
// override. Package review keeps those fences as source rather than loading them.
const previewPlugins = { ...markdownPlugins };
delete previewPlugins.mermaid;
const previewComponents = {
  ...markdownTableComponents,
  img: ({ alt }: { alt?: string | undefined }) => (
    <span className="text-muted-foreground">[Image{alt ? `: ${alt}` : ""}, not loaded]</span>
  ),
};
export function SkillPreview({ content }: { content: string }) {
  return (
    <div className="min-w-0 break-words p-5">
      <Streamdown
        linkSafety={LINK_SAFETY}
        mode="static"
        plugins={previewPlugins}
        components={previewComponents}
        skipHtml
      >
        {content}
      </Streamdown>
    </div>
  );
}
interface TreeNode {
  readonly path: string;
  readonly name: string;
  readonly folder: boolean;
  readonly children: TreeNode[];
}

interface Draft {
  readonly kind: "file" | "folder" | "rename";
  /** Parent folder for a new entry; "" is the package root. */
  readonly parent: string;
  readonly target?: string;
}

/** Folders before files, then alphabetical: the ordering file explorers use. */
function buildTree(paths: string[], folders: Set<string>): TreeNode[] {
  const roots: TreeNode[] = [];
  const nodes = new Map<string, TreeNode>();
  const ensure = (path: string, folder: boolean): TreeNode => {
    const existing = nodes.get(path);
    if (existing) return existing;
    const cut = path.lastIndexOf("/");
    const node: TreeNode = { path, name: path.slice(cut + 1), folder, children: [] };
    nodes.set(path, node);
    if (cut === -1) roots.push(node);
    else ensure(path.slice(0, cut), true).children.push(node);
    return node;
  };
  // oxlint-disable-next-line no-array-sort -- sorts the fresh copy above
  for (const folder of [...folders].sort()) ensure(folder, true);
  for (const path of paths) ensure(path, false);
  sortTree(roots);
  return roots;
}

function sortTree(list: TreeNode[]) {
  // oxlint-disable-next-line no-array-sort -- built inside buildTree
  list.sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name));
  for (const node of list) sortTree(node.children);
}

const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

const chevronClassName =
  "text-muted-foreground size-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none";
// `w-max min-w-full` keeps hover and selection spanning the full width while
// letting a deep path extend past the rail, which scrolls sideways for it.
const rowClassName = cn(
  focusRingClassName,
  "flex h-7 w-max min-w-full items-center gap-1.5 rounded-lg pr-2 pl-1.5 text-left text-xs whitespace-nowrap",
);

/** The inline name field: Enter commits, Escape cancels, blur commits like VS Code. */
function DraftRow({
  folder,
  chevron,
  label,
  value,
  error,
  onChange,
  onCommit,
  onCancel,
}: {
  folder: boolean;
  /** Open state of the folder being renamed; absent for a new entry. */
  chevron?: boolean | undefined;
  label: string;
  value: string;
  error: string | null;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  return (
    <div data-entry={folder ? "folder" : "file"}>
      <div className={rowClassName}>
        {chevron === undefined ? (
          <span aria-hidden className="size-3.5 shrink-0" />
        ) : (
          // Renaming replaces the label, not the row: the chevron stays put.
          <HugeiconsIcon
            icon={ArrowRight01Icon}
            strokeWidth={2}
            aria-hidden
            className={cn(chevronClassName, chevron && "rotate-90")}
          />
        )}
        <HugeiconsIcon
          icon={folder ? Folder01Icon : File01Icon}
          strokeWidth={2}
          className="text-muted-foreground size-3.5 shrink-0"
        />
        <input
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- the row exists to be typed into
          autoFocus
          aria-label={label}
          value={value}
          spellCheck={false}
          className="border-input focus-visible:border-ring h-6 min-w-0 flex-1 rounded-md border bg-transparent px-1.5 text-xs outline-none"
          onChange={(event) => onChange(event.target.value)}
          onBlur={() => (value.trim() ? onCommit() : onCancel())}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onCommit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              onCancel();
            }
          }}
        />
      </div>
      {error ? (
        <div className="max-w-full px-2 pt-1 pb-0.5">
          <FieldError className="min-w-0 wrap-anywhere">{error}</FieldError>
        </div>
      ) : null}
    </div>
  );
}

function FileTree({
  nodes,
  selected,
  expanded,
  draft,
  onSelect,
  onToggle,
  onRename,
  renderDraft,
}: {
  nodes: TreeNode[];
  selected: string;
  expanded: Set<string>;
  draft: Draft | null;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
  onRename: (path: string) => void;
  renderDraft: () => ReactNode;
}) {
  return (
    <>
      {nodes.map((node) => {
        const open = node.folder && expanded.has(node.path);
        const renaming = draft?.kind === "rename" && draft.target === node.path;
        return (
          <div key={node.path}>
            {renaming ? renderDraft() : null}
            <button
              hidden={renaming}
              type="button"
              aria-current={selected === node.path ? "page" : undefined}
              aria-expanded={node.folder ? open : undefined}
              className={cn(
                rowClassName,
                "hover:bg-muted/60",
                selected === node.path && "bg-muted hover:bg-muted font-medium",
              )}
              onClick={() => {
                onSelect(node.path);
                if (node.folder) onToggle(node.path);
              }}
              onDoubleClick={() => onRename(node.path)}
            >
              {node.folder ? (
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  strokeWidth={2}
                  className={cn(chevronClassName, open && "rotate-90")}
                />
              ) : (
                // Keeps file names aligned with folder names beside them.
                <span aria-hidden className="size-3.5 shrink-0" />
              )}
              <HugeiconsIcon
                icon={node.folder ? Folder01Icon : File01Icon}
                strokeWidth={2}
                className="text-muted-foreground size-3.5 shrink-0"
              />
              <span>{node.name}</span>
            </button>
            {open ? (
              <div className="border-border/60 ml-3 border-l">
                {draft && draft.kind !== "rename" && draft.parent === node.path
                  ? renderDraft()
                  : null}
                <FileTree
                  nodes={node.children}
                  selected={selected}
                  expanded={expanded}
                  draft={draft}
                  onSelect={onSelect}
                  onToggle={onToggle}
                  onRename={onRename}
                  renderDraft={renderDraft}
                />
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

const noDownload = () => null;
const noPreview = () => null;

/** Stores a picked file for the draft and says what the server kept. */
export type SkillUpload = (file: File) => Promise<{
  uploadId: string;
  size: number;
  mediaType: string;
}>;

/** Opens the system picker and hands over the one file chosen. */
function useFilePicker(onPick: (file: File) => void) {
  const input = useRef<HTMLInputElement>(null);
  const element = (
    <input
      ref={input}
      type="file"
      className="sr-only"
      tabIndex={-1}
      aria-hidden
      onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (file) onPick(file);
      }}
    />
  );
  return { element, open: () => input.current?.click() };
}

/** A template, image or font: described, previewed where it can be, never edited as text. */
function BinaryFileView({
  file,
  href,
  preview,
  pending,
  onReplace,
}: {
  file: SkillBinaryFile;
  href: string | null;
  preview: AttachmentPreviewTarget | null;
  pending: boolean;
  onReplace?: (() => void) | undefined;
}) {
  const name = file.path.slice(file.path.lastIndexOf("/") + 1);
  return (
    <div className="flex flex-col items-start gap-4 p-5">
      <div className="flex w-full min-w-0 items-center gap-3">
        <div className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-2xl">
          <HugeiconsIcon icon={File01Icon} strokeWidth={2} className="size-4" />
        </div>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium">{name}</span>
          <span className="text-muted-foreground truncate text-xs" title={file.binary.mediaType}>
            {file.binary.mediaType} · {formatFileSize(file.binary.size)}
          </span>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {href ? (
          <a
            href={href}
            download={name}
            className={buttonVariants({ size: "sm", variant: "outline" })}
          >
            <HugeiconsIcon icon={Download01Icon} strokeWidth={2} data-icon="inline-start" />
            Download
          </a>
        ) : null}
        {onReplace ? (
          <PendingButton size="sm" variant="outline" pending={pending} onClick={onReplace}>
            <HugeiconsIcon icon={Upload01Icon} strokeWidth={2} data-icon="inline-start" />
            Replace
          </PendingButton>
        ) : null}
      </div>
      {preview ? (
        <div className="w-full min-w-0">
          <FilePreviewBody target={preview} linkable={false} />
        </div>
      ) : null}
    </div>
  );
}

/** Stable editor identities survive both file switches and path renames. */
export function PackageWorkspace({
  files,
  onChange,
  readOnly = onChange === undefined,
  findings = noFindings,
  autoFocus = false,
  upload,
  downloadHref = noDownload,
  preview: previewOf = noPreview,
}: {
  files: SkillFile[];
  onChange?: (files: SkillFile[]) => void;
  readOnly?: boolean;
  findings?: SkillFinding[];
  autoFocus?: boolean;
  /** Absent where the package cannot take new binary files. */
  upload?: SkillUpload | undefined;
  /** Where a binary file of the draft downloads from, if anywhere yet. */
  downloadHref?: (file: SkillBinaryFile) => string | null;
  /** What the shared file preview shows for a binary file, if anything. */
  preview?: (file: SkillBinaryFile) => AttachmentPreviewTarget | null;
}) {
  const confirm = useConfirm();
  const [uploading, setUploading] = useState(false);
  // One rail, never two: a second copy would mount a second inline name field,
  // and its autofocus would blur, and so cancel, the one being typed into.
  const isMobile = useIsMobile();
  const [filesOpen, setFilesOpen] = useState(false);
  const [selected, setSelected] = useState("SKILL.md");
  const [visited, setVisited] = useState(["SKILL.md"]);
  const [identities, setIdentities] = useState<Record<string, string>>(() =>
    Object.fromEntries(files.map((file) => [file.path, file.path])),
  );
  const [draftFolders, setDraftFolders] = useState<string[]>([]);
  const [preview, setPreview] = useState(readOnly);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Folders start open, so only the ones deliberately closed need tracking.
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [focusRequest, setFocusRequest] = useState<{
    path: string;
    line: number;
    sequence: number;
  } | null>(null);
  const folders = new Set(draftFolders);
  for (const file of files) {
    const parts = file.path.split("/");
    for (let length = 1; length < parts.length; length++)
      folders.add(parts.slice(0, length).join("/"));
  }
  const isFolder = folders.has(selected);
  const file = files.find((entry) => entry.path === selected) ?? (isFolder ? undefined : files[0]);
  const select = (next: string) => {
    setSelected(next);
    setVisited((current) => (current.includes(next) ? current : [...current, next]));
  };
  const commit = () => {
    let chained: Draft | null = null;
    const typed = name.trim().replace(/^\/+|\/+$/gu, "");
    const parent = draft?.parent ?? "";
    const path = parent ? `${parent}/${typed}` : typed;
    try {
      if (!draft) return;
      validateSkillPath(path);
      if (path !== draft.target) {
        if (
          [...files.map((entry) => entry.path), ...folders].some(
            (existing) => existing.toLowerCase() === path.toLowerCase(),
          )
        )
          throw new Error("A file or folder already uses this name.");
        if (files.some((entry) => path.toLowerCase().startsWith(`${entry.path.toLowerCase()}/`)))
          throw new Error("A parent path is already a file.");
      }
      if (draft.kind === "folder") {
        setDraftFolders((current) => [...current, path]);
        select(path);
        // A package stores files, not folders, so a folder only becomes real
        // once it holds one: name the first file straight away.
        chained = { kind: "file", parent: path };
      } else if (draft.kind === "file") {
        setIdentities((current) => ({ ...current, [path]: crypto.randomUUID() }));
        onChange?.([...files, { path, content: "" }]);
        select(path);
        setPreview(false);
      } else {
        const target = draft.target!;
        if (target === "SKILL.md") throw new Error("Root SKILL.md cannot be renamed.");
        const targetIsFolder = folders.has(target);
        const renamed = new Map(
          files
            .filter(
              (entry) =>
                entry.path === target || (targetIsFolder && entry.path.startsWith(`${target}/`)),
            )
            .map((entry) => [entry.path, `${path}${entry.path.slice(target.length)}`]),
        );
        for (const next of renamed.values()) validateSkillPath(next);
        const nextFiles = files.map((entry) => ({
          ...entry,
          path: renamed.get(entry.path) ?? entry.path,
        }));
        if (new Set(nextFiles.map((entry) => entry.path.toLowerCase())).size !== nextFiles.length)
          throw new Error("Renaming would replace another file.");
        setIdentities((current) =>
          Object.fromEntries(
            Object.entries(current).map(([old, identity]) => [renamed.get(old) ?? old, identity]),
          ),
        );
        setVisited((current) => current.map((old) => renamed.get(old) ?? old));
        setDraftFolders((current) =>
          current.map((old) =>
            old === target || old.startsWith(`${target}/`)
              ? `${path}${old.slice(target.length)}`
              : old,
          ),
        );
        onChange?.(nextFiles);
        select(path);
      }
      setDraft(chained);
      setName("");
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Invalid file name.");
    }
  };
  const cancel = () => {
    setDraft(null);
    setName("");
    setError(null);
  };
  // New entries land inside the selected folder, or beside the selected file.
  const create = (kind: "file" | "folder") => {
    const parent = isFolder ? selected : parentOf(selected);
    setCollapsed((current) => current.filter((path) => path !== parent));
    setDraft({ kind, parent });
    setName("");
    setError(null);
  };
  const rename = (target = selected) => {
    if (target === "SKILL.md") return;
    setDraft({ kind: "rename", parent: parentOf(target), target });
    setName(target.slice(target.lastIndexOf("/") + 1));
    setError(null);
  };
  /**
   * A picked file lands beside the selection, or replaces one. Skill text stays
   * editable text; anything else is uploaded and kept as a binary file.
   */
  const addFile = async (picked: File, target?: string) => {
    const parent = isFolder ? selected : parentOf(selected);
    const path = target ?? (parent ? `${parent}/${picked.name}` : picked.name);
    try {
      validateSkillPath(path);
      if (path === "SKILL.md") throw new Error("Root SKILL.md cannot be replaced by an upload.");
      if (picked.size > SKILL_LIMITS.binaryFileBytes)
        throw new Error(`Files can be at most ${formatFileSize(SKILL_LIMITS.binaryFileBytes)}.`);
      if (
        !target &&
        files.some((entry) => entry.path.toLowerCase() === path.toLowerCase()) &&
        !(await confirm({
          title: `Replace “${path}”?`,
          description:
            "The uploaded file takes its place in your draft. Save to publish the change.",
          confirmLabel: "Replace",
        }))
      )
        return;
      setUploading(true);
      const classified = classifySkillFile(path, new Uint8Array(await picked.arrayBuffer()));
      const next: SkillFile = isBinarySkillFile(classified)
        ? { path, binary: await upload!(picked) }
        : classified;
      const rest = files.filter((entry) => entry.path.toLowerCase() !== path.toLowerCase());
      setIdentities((current) => ({ ...current, [path]: crypto.randomUUID() }));
      onChange?.([...rest, next]);
      select(path);
      setPreview(false);
    } catch (cause) {
      toastError("Could not add the file.", cause);
    } finally {
      setUploading(false);
    }
  };
  const picker = useFilePicker((picked) => void addFile(picked));
  const replacer = useFilePicker((picked) => void addFile(picked, selected));
  const remove = async () => {
    const affected = files.filter(
      (entry) => entry.path === selected || (isFolder && entry.path.startsWith(`${selected}/`)),
    );
    if (
      affected.some((entry) => isBinarySkillFile(entry) || entry.content.length > 0) &&
      !(await confirm({
        title: `Delete “${selected}”?`,
        description: "This removes the selected files from your draft. Save to publish the change.",
        confirmLabel: "Delete",
      }))
    )
      return;
    onChange?.(files.filter((entry) => !affected.includes(entry)));
    setDraftFolders((current) =>
      current.filter((folder) => folder !== selected && !folder.startsWith(`${selected}/`)),
    );
    select("SKILL.md");
  };
  const renamingFolder = !!draft?.target && folders.has(draft.target);
  const renderDraft = () => (
    <DraftRow
      folder={renamingFolder || draft?.kind === "folder"}
      {...(renamingFolder ? { chevron: !collapsed.includes(draft!.target!) } : {})}
      label={
        draft?.kind === "folder"
          ? "New folder name"
          : draft?.kind === "file"
            ? "New file name"
            : "New name"
      }
      value={name}
      error={error}
      onChange={setName}
      onCommit={commit}
      onCancel={cancel}
    />
  );
  const expanded = new Set([...folders].filter((path) => !collapsed.includes(path)));
  const navigation = (
    <nav aria-label="Skill files" className="flex flex-col gap-1 overflow-x-auto p-2">
      <div className="flex h-7 items-center gap-1 pl-1.5">
        <span className="text-muted-foreground flex-1 text-2xs font-medium tracking-wide uppercase">
          Files
        </span>
        {!readOnly ? (
          <>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="New file"
              onClick={() => create("file")}
            >
              <HugeiconsIcon icon={FileAddIcon} strokeWidth={2} />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="New folder"
              onClick={() => create("folder")}
            >
              <HugeiconsIcon icon={FolderAddIcon} strokeWidth={2} />
            </Button>
            {upload ? (
              <PendingButton
                size="icon-sm"
                variant="ghost"
                aria-label="Upload file"
                pending={uploading}
                onClick={picker.open}
              >
                <HugeiconsIcon icon={FileUploadIcon} strokeWidth={2} />
              </PendingButton>
            ) : null}
          </>
        ) : null}
      </div>
      <div>
        {draft && draft.kind !== "rename" && draft.parent === "" ? renderDraft() : null}
        <FileTree
          nodes={buildTree(
            files.map((entry) => entry.path),
            folders,
          )}
          selected={selected}
          expanded={expanded}
          draft={draft}
          onSelect={select}
          onRename={readOnly ? () => {} : rename}
          onToggle={(path) =>
            setCollapsed((current) =>
              current.includes(path)
                ? current.filter((entry) => entry !== path)
                : [...current, path],
            )
          }
          renderDraft={renderDraft}
        />
      </div>
    </nav>
  );
  const binary = file && isBinarySkillFile(file) ? file : null;
  return (
    <div className="min-w-0 space-y-3">
      {picker.element}
      {replacer.element}
      <div className={cn(cardSurfaceClassName, "min-w-0 overflow-hidden")}>
        {isMobile ? (
          <div className="border-b">
            <button
              type="button"
              aria-expanded={filesOpen}
              className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm"
              onClick={() => setFilesOpen((open) => !open)}
            >
              <HugeiconsIcon
                icon={ArrowRight01Icon}
                strokeWidth={2}
                className={cn(chevronClassName, "size-4", filesOpen && "rotate-90")}
              />
              <span className="min-w-0 flex-1 truncate">Files · {selected}</span>
            </button>
            {filesOpen ? navigation : null}
          </div>
        ) : null}
        <div className="grid min-w-0 md:grid-cols-[15rem_minmax(0,1fr)]">
          {isMobile ? null : <div className="border-r">{navigation}</div>}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
              <span className="min-w-0 flex-1 truncate text-xs font-medium">{selected}</span>
              {!readOnly && selected !== "SKILL.md" ? (
                <>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button size="icon-sm" variant="ghost" aria-label={`Rename ${selected}`} />
                      }
                      onClick={() => rename()}
                    >
                      <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} />
                    </TooltipTrigger>
                    <TooltipContent>Rename (or double-click in the tree)</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button size="icon-sm" variant="ghost" aria-label={`Delete ${selected}`} />
                      }
                      onClick={() => {
                        void remove();
                      }}
                    >
                      <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                    </TooltipTrigger>
                    <TooltipContent>Delete</TooltipContent>
                  </Tooltip>
                </>
              ) : null}
              {isFolder || binary ? null : (
                <ViewToggle
                  preview={preview}
                  sourceLabel={readOnly ? "Source" : "Edit"}
                  onChange={setPreview}
                />
              )}
            </div>
            {isFolder ? (
              <div className="flex flex-col items-start gap-3 p-5">
                <p className="text-muted-foreground text-sm">
                  {files.some((entry) => entry.path.startsWith(`${selected}/`))
                    ? "Choose a file in this folder to edit it."
                    : "This folder is empty. A skill stores files, so it is saved once it holds one."}
                </p>
                {readOnly ? null : (
                  <Button size="sm" variant="outline" onClick={() => create("file")}>
                    <HugeiconsIcon icon={FileAddIcon} strokeWidth={2} data-icon="inline-start" />
                    Add file
                  </Button>
                )}
              </div>
            ) : binary ? (
              <BinaryFileView
                file={binary}
                href={downloadHref(binary)}
                preview={previewOf(binary)}
                pending={uploading}
                onReplace={readOnly || !upload ? undefined : replacer.open}
              />
            ) : preview && file && !isBinarySkillFile(file) ? (
              <SkillPreview content={file.content} />
            ) : null}
            <Suspense
              fallback={<p className="text-muted-foreground p-5 text-sm">Loading editor…</p>}
            >
              {files
                .filter((entry) => visited.includes(entry.path))
                .flatMap((entry) => (isBinarySkillFile(entry) ? [] : [entry]))
                .map((entry) => (
                  <div
                    key={identities[entry.path] ?? entry.path}
                    hidden={isFolder || preview || entry.path !== file?.path}
                  >
                    <TextEditor
                      value={entry.content}
                      path={entry.path}
                      label={`Edit ${entry.path}`}
                      readOnly={readOnly}
                      autoFocus={autoFocus && entry.path === "SKILL.md"}
                      focusRequest={focusRequest?.path === entry.path ? focusRequest : undefined}
                      onChange={(content) =>
                        onChange?.(
                          files.map((current) =>
                            current.path === entry.path ? { ...current, content } : current,
                          ),
                        )
                      }
                    />
                  </div>
                ))}
            </Suspense>
          </div>
        </div>
      </div>
      {findings.length ? (
        <ul className="space-y-2 text-xs">
          {findings.map((finding) => (
            <li
              key={`${finding.path}:${finding.line ?? 0}:${finding.message}`}
              className={
                finding.severity === "error"
                  ? "text-destructive wrap-anywhere"
                  : "text-muted-foreground wrap-anywhere"
              }
            >
              <button
                type="button"
                className="underline underline-offset-4"
                onClick={() => {
                  select(finding.path);
                  setPreview(false);
                  setFocusRequest((current) => ({
                    path: finding.path,
                    line: finding.line ?? 1,
                    sequence: (current?.sequence ?? 0) + 1,
                  }));
                }}
              >
                {finding.path}
                {finding.line ? `:${finding.line}` : ""}
              </button>{" "}
              · {finding.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
