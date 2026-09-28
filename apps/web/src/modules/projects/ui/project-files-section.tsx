import {
  ArrowTurnBackwardIcon,
  Delete02Icon,
  Download01Icon,
  File01Icon,
  FileUploadIcon,
  MoreHorizontalIcon,
  PinIcon,
  PinOffIcon,
  Time04Icon,
  Upload01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { formatFileSize } from "~/modules/attachments/constants.ts";
import { AttachmentPreviewDialog } from "~/modules/attachments/ui/attachment-preview.tsx";
import { presentationSource } from "~/modules/attachments/ui/presentation-preview.tsx";
import { relativeAgeLabel } from "~/modules/chat/ui/timestamps.ts";
import { useConfirm } from "~/ui/confirm.tsx";
import { toastError } from "~/ui/error-toast.ts";
import { ErrorState, ListCard, ListRow, ListSkeleton, Section } from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Badge } from "~/ui/primitives/badge";
import { Button, buttonVariants } from "~/ui/primitives/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/ui/primitives/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { Field, FieldDescription, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import { projectFilesQuery, projectFileVersionsQuery } from "../client/queries.ts";
import { PROJECT_FILE_LIMITS, type ProjectFileSummary, type ProjectFileVersion } from "../files.ts";
import {
  deleteProjectFile,
  pinProjectFileVersion,
  restoreProjectFileVersion,
  uploadProjectFile,
} from "../server/functions.ts";

const downloadHref = (versionId: string) => `/api/project-files/${versionId}`;

/** One upload: a new file, or a new version of `target` keeping its name. */
function useUpload(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ file, target }: { file: File; target?: ProjectFileSummary }) => {
      const data = new FormData();
      // A new version keeps the file's name, whatever the upload was called.
      data.set("file", target ? new File([file], target.name, { type: file.type }) : file);
      data.set("projectId", projectId);
      if (target) {
        data.set("fileId", target.id);
        data.set("basedOnVersion", String(target.version));
      }
      return uploadProjectFile({ data });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["projects"] }),
    onError: (error) => toastError("Could not upload the file.", error),
  });
}

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
        if (!file) return;
        if (file.size > PROJECT_FILE_LIMITS.fileBytes) {
          toastError("Could not upload the file.", new Error("The file is larger than 50 MB."));
          return;
        }
        onPick(file);
      }}
    />
  );
  return { element, open: () => input.current?.click() };
}

export function ProjectFilesSection({
  projectId,
  editable,
}: {
  projectId: string;
  editable: boolean;
}) {
  const files = useQuery(projectFilesQuery(projectId));
  const upload = useUpload(projectId);
  const picker = useFilePicker((file) => upload.mutate({ file }));
  const [history, setHistory] = useState<ProjectFileSummary | null>(null);
  const list = files.data;
  return (
    <Section
      title="Files"
      description="Decks, spreadsheets and other files everyone works on, with 30 days of history."
      actions={
        editable ? (
          <PendingButton
            size="sm"
            variant="outline"
            pending={upload.isPending}
            onClick={picker.open}
          >
            <HugeiconsIcon icon={FileUploadIcon} strokeWidth={2} data-icon="inline-start" />
            Upload file
          </PendingButton>
        ) : null
      }
    >
      {picker.element}
      {files.isError ? (
        <ErrorState
          title="Could not load files"
          onRetry={() => {
            void files.refetch();
          }}
        />
      ) : !list ? (
        <ListSkeleton label="Loading files" />
      ) : list.files.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {editable
            ? "No files yet. Upload one here, or save one from a project chat."
            : "No files yet."}
        </p>
      ) : (
        <>
          <ListCard>
            {list.files.map((file) => (
              <ProjectFileRow
                key={file.id}
                projectId={projectId}
                file={file}
                editable={editable}
                onHistory={() => setHistory(file)}
              />
            ))}
          </ListCard>
          <p className="text-muted-foreground text-xs">
            {formatFileSize(list.usedBytes)} of {formatFileSize(list.maxBytes)} used, history
            included
          </p>
        </>
      )}
      <VersionsDialog
        file={history}
        editable={editable}
        onOpenChange={(open) => {
          if (!open) setHistory(null);
        }}
      />
    </Section>
  );
}

function ProjectFileRow({
  projectId,
  file,
  editable,
  onHistory,
}: {
  projectId: string;
  file: ProjectFileSummary;
  editable: boolean;
  onHistory: () => void;
}) {
  const confirm = useConfirm();
  const [previewOpen, setPreviewOpen] = useState(false);
  const queryClient = useQueryClient();
  const upload = useUpload(projectId);
  const picker = useFilePicker((picked) => upload.mutate({ file: picked, target: file }));
  const remove = useMutation({
    mutationFn: () => deleteProjectFile({ data: { fileId: file.id } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["projects"] }),
    onError: (error) => toastError("Could not delete the file.", error),
  });
  const by = file.origin === "model" ? "the assistant" : file.updatedBy;
  const presentation = presentationSource(
    { fileName: file.name, mediaType: file.mediaType },
    { kind: "project-version", id: file.versionId },
  );
  const detail = [
    `Version ${file.version}`,
    formatFileSize(file.size),
    `Updated ${relativeAgeLabel(file.updatedAt)}${by ? ` by ${by}` : ""}`,
  ].join(" · ");
  return (
    <ListRow>
      {picker.element}
      <div className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-2xl">
        <HugeiconsIcon icon={File01Icon} strokeWidth={2} className="size-4" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{file.name}</span>
        <span className="text-muted-foreground truncate text-xs">
          {upload.isPending ? "Uploading a new version…" : detail}
        </span>
      </div>
      {presentation ? (
        <>
          <Button size="sm" variant="outline" onClick={() => setPreviewOpen(true)}>
            Preview
          </Button>
          <AttachmentPreviewDialog
            target={{
              fileName: file.name,
              size: file.size,
              kind: "file",
              url: downloadHref(file.versionId),
              presentation,
            }}
            open={previewOpen}
            onOpenChange={setPreviewOpen}
          />
        </>
      ) : null}
      <a
        href={downloadHref(file.versionId)}
        download={file.name}
        className={buttonVariants({ size: "icon-sm", variant: "ghost" })}
        aria-label={`Download ${file.name}`}
      >
        <HugeiconsIcon icon={Download01Icon} strokeWidth={2} />
      </a>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button size="icon-sm" variant="ghost" aria-label={`Actions for ${file.name}`} />}
        >
          <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {editable ? (
            <DropdownMenuItem disabled={upload.isPending} onClick={picker.open}>
              <HugeiconsIcon icon={Upload01Icon} strokeWidth={2} />
              Upload new version
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onClick={onHistory}>
            <HugeiconsIcon icon={Time04Icon} strokeWidth={2} />
            Version history
          </DropdownMenuItem>
          {editable ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={remove.isPending}
                onClick={() => {
                  void confirm({
                    title: `Delete “${file.name}”?`,
                    description: "The file and every saved version are deleted for everyone.",
                    confirmLabel: "Delete file",
                  }).then((confirmed) => {
                    if (confirmed) remove.mutate();
                  });
                }}
              >
                <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                Delete
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </ListRow>
  );
}

function VersionsDialog({
  file,
  editable,
  onOpenChange,
}: {
  file: ProjectFileSummary | null;
  editable: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={!!file} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Version history</DialogTitle>
          <DialogDescription>
            {file ? <span className="block wrap-anywhere">{file.name}</span> : null}
            Versions stay for 30 days, up to {PROJECT_FILE_LIMITS.historyVersions}. Pin one to keep
            it.
          </DialogDescription>
        </DialogHeader>
        {file ? <VersionList file={file} editable={editable} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function VersionList({ file, editable }: { file: ProjectFileSummary; editable: boolean }) {
  const versions = useQuery(projectFileVersionsQuery(file.id));
  const queryClient = useQueryClient();
  const [pinning, setPinning] = useState<ProjectFileVersion | null>(null);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["projects"] });
  const restore = useMutation({
    mutationFn: (version: ProjectFileVersion) =>
      restoreProjectFileVersion({
        data: { versionId: version.id, basedOnVersion: file.version },
      }),
    onSuccess: invalidate,
    onError: (error) => toastError("Could not restore the version.", error),
  });
  const unpin = useMutation({
    mutationFn: (version: ProjectFileVersion) =>
      pinProjectFileVersion({ data: { versionId: version.id, pinned: false } }),
    onSuccess: invalidate,
    onError: (error) => toastError("Could not unpin the version.", error),
  });
  if (versions.isError)
    return (
      <ErrorState
        title="Could not load versions"
        onRetry={() => {
          void versions.refetch();
        }}
      />
    );
  if (!versions.data) return <ListSkeleton label="Loading versions" />;
  return (
    <>
      <ListCard>
        {versions.data.map((version) => {
          const by = version.origin === "model" ? "the assistant" : version.createdBy;
          return (
            <ListRow key={version.id}>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
                  <span className="truncate">{version.label ?? `Version ${version.number}`}</span>
                  {version.current ? <Badge variant="secondary">Current</Badge> : null}
                  {version.pinned ? (
                    <HugeiconsIcon
                      icon={PinIcon}
                      strokeWidth={2}
                      className="text-muted-foreground size-3.5 shrink-0"
                      aria-label="Pinned"
                    />
                  ) : null}
                </span>
                <span className="text-muted-foreground truncate text-xs">
                  {[
                    version.label ? `Version ${version.number}` : null,
                    formatFileSize(version.size),
                    `${relativeAgeLabel(version.createdAt)}${by ? ` by ${by}` : ""}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </div>
              <a
                href={downloadHref(version.id)}
                download={file.name}
                className={buttonVariants({ size: "icon-sm", variant: "ghost" })}
                aria-label={`Download version ${version.number}`}
              >
                <HugeiconsIcon icon={Download01Icon} strokeWidth={2} />
              </a>
              {editable ? (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Actions for version ${version.number}`}
                      />
                    }
                  >
                    <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {version.current ? null : (
                      <DropdownMenuItem
                        disabled={restore.isPending}
                        onClick={() => restore.mutate(version)}
                      >
                        <HugeiconsIcon icon={ArrowTurnBackwardIcon} strokeWidth={2} />
                        Restore as current
                      </DropdownMenuItem>
                    )}
                    {version.pinned ? (
                      <DropdownMenuItem
                        disabled={unpin.isPending}
                        onClick={() => unpin.mutate(version)}
                      >
                        <HugeiconsIcon icon={PinOffIcon} strokeWidth={2} />
                        Unpin
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem onClick={() => setPinning(version)}>
                        <HugeiconsIcon icon={PinIcon} strokeWidth={2} />
                        Pin…
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </ListRow>
          );
        })}
      </ListCard>
      <PinDialog
        version={pinning}
        onOpenChange={(open) => {
          if (!open) setPinning(null);
        }}
      />
    </>
  );
}

function PinDialog({
  version,
  onOpenChange,
}: {
  version: ProjectFileVersion | null;
  onOpenChange: (open: boolean) => void;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const [label, setLabel] = useState("");
  const pin = useMutation({
    mutationFn: (target: ProjectFileVersion) =>
      pinProjectFileVersion({
        data: {
          versionId: target.id,
          pinned: true,
          ...(label.trim() ? { label: label.trim() } : {}),
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      setLabel("");
      onOpenChange(false);
    },
    onError: (error) => toastError("Could not pin the version.", error),
  });
  return (
    <Dialog
      open={!!version}
      onOpenChange={(next) => {
        if (!next && pin.isPending) return;
        if (!next) setLabel("");
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{version ? `Pin version ${version.number}` : "Pin version"}</DialogTitle>
          <DialogDescription>
            A pinned version is kept until someone unpins it. A file keeps up to{" "}
            {PROJECT_FILE_LIMITS.pinsPerFile}.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            if (version) pin.mutate(version);
          }}
        >
          <Field>
            <FieldLabel htmlFor={`${id}-label`}>Label</FieldLabel>
            <Input
              id={`${id}-label`}
              value={label}
              maxLength={80}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Sent to the client"
              disabled={pin.isPending}
              autoFocus
            />
            <FieldDescription>Optional. Shown in place of the version number.</FieldDescription>
          </Field>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={pin.isPending} />}>
              Cancel
            </DialogClose>
            <PendingButton type="submit" pending={pin.isPending}>
              Pin version
            </PendingButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
