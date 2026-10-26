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
import { officePreview } from "~/modules/attachments/ui/office-preview.ts";
import { relativeAgeLabel } from "~/modules/chat/ui/timestamps.ts";
import { useConfirm } from "~/ui/confirm-context.ts";
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
import { m } from "~/paraglide/messages.js";
import { formatLocale } from "~/i18n/formats.ts";

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
    onError: (error) => toastError(m.projects_files_upload_failed(), error),
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
          toastError(m.projects_files_upload_failed(), new Error(m.projects_files_too_large()));
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
      title={m.projects_files_title()}
      description={m.projects_files_description()}
      actions={
        editable ? (
          <PendingButton
            size="sm"
            variant="outline"
            pending={upload.isPending}
            onClick={picker.open}
          >
            <HugeiconsIcon icon={FileUploadIcon} strokeWidth={2} data-icon="inline-start" />
            {m.projects_files_upload()}
          </PendingButton>
        ) : null
      }
    >
      {picker.element}
      {files.isError ? (
        <ErrorState
          title={m.projects_files_load_failed()}
          onRetry={() => {
            void files.refetch();
          }}
        />
      ) : !list ? (
        <ListSkeleton label={m.projects_files_loading()} />
      ) : list.files.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {editable ? m.projects_files_empty_editable() : m.projects_files_empty()}
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
            {m.projects_files_used({ size: formatFileSize(list.usedBytes, formatLocale()) })}
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
    onError: (error) => toastError(m.projects_files_delete_failed(), error),
  });
  const age = relativeAgeLabel(file.updatedAt, undefined, formatLocale());
  const office = officePreview(
    { fileName: file.name, mediaType: file.mediaType },
    { kind: "project-version", id: file.versionId },
  );
  const detail = [
    m.projects_files_version({ number: file.version }),
    formatFileSize(file.size, formatLocale()),
    file.origin === "model"
      ? m.projects_files_updated_by_assistant({ age })
      : file.updatedBy
        ? m.projects_files_updated_by({ age, name: file.updatedBy })
        : m.projects_files_updated({ age }),
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
          {upload.isPending ? m.projects_files_uploading_version() : detail}
        </span>
      </div>
      {office ? (
        <>
          <Button size="sm" variant="outline" onClick={() => setPreviewOpen(true)}>
            {m.projects_files_preview()}
          </Button>
          <AttachmentPreviewDialog
            target={{
              fileName: file.name,
              size: file.size,
              kind: "file",
              url: downloadHref(file.versionId),
              office,
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
        aria-label={m.projects_files_download({ name: file.name })}
      >
        <HugeiconsIcon icon={Download01Icon} strokeWidth={2} />
      </a>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={m.projects_files_actions({ name: file.name })}
            />
          }
        >
          <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {editable ? (
            <DropdownMenuItem disabled={upload.isPending} onClick={picker.open}>
              <HugeiconsIcon icon={Upload01Icon} strokeWidth={2} />
              {m.projects_files_upload_version()}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onClick={onHistory}>
            <HugeiconsIcon icon={Time04Icon} strokeWidth={2} />
            {m.projects_files_history()}
          </DropdownMenuItem>
          {editable ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={remove.isPending}
                onClick={() => {
                  void confirm({
                    title: m.projects_files_delete_title({ name: file.name }),
                    description: m.projects_files_delete_description(),
                    confirmLabel: m.projects_files_delete(),
                  }).then((confirmed) => {
                    if (confirmed) remove.mutate();
                  });
                }}
              >
                <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                {m.common_delete()}
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
          <DialogTitle>{m.projects_files_history()}</DialogTitle>
          <DialogDescription>
            {file ? <span className="block wrap-anywhere">{file.name}</span> : null}
            {m.projects_files_history_description({ max: PROJECT_FILE_LIMITS.historyVersions })}
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
    onError: (error) => toastError(m.projects_files_restore_failed(), error),
  });
  const unpin = useMutation({
    mutationFn: (version: ProjectFileVersion) =>
      pinProjectFileVersion({ data: { versionId: version.id, pinned: false } }),
    onSuccess: invalidate,
    onError: (error) => toastError(m.projects_files_unpin_failed(), error),
  });
  if (versions.isError)
    return (
      <ErrorState
        title={m.projects_files_versions_load_failed()}
        onRetry={() => {
          void versions.refetch();
        }}
      />
    );
  if (!versions.data) return <ListSkeleton label={m.projects_files_versions_loading()} />;
  return (
    <>
      <ListCard>
        {versions.data.map((version) => {
          const age = relativeAgeLabel(version.createdAt, undefined, formatLocale());
          return (
            <ListRow key={version.id}>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
                  <span className="truncate">
                    {version.label ?? m.projects_files_version({ number: version.number })}
                  </span>
                  {version.current ? (
                    <Badge variant="secondary">{m.projects_files_current()}</Badge>
                  ) : null}
                  {version.pinned ? (
                    <HugeiconsIcon
                      icon={PinIcon}
                      strokeWidth={2}
                      className="text-muted-foreground size-3.5 shrink-0"
                      aria-label={m.projects_files_pinned()}
                    />
                  ) : null}
                </span>
                <span className="text-muted-foreground truncate text-xs">
                  {[
                    version.label ? m.projects_files_version({ number: version.number }) : null,
                    formatFileSize(version.size, formatLocale()),
                    version.origin === "model"
                      ? m.projects_files_created_by_assistant({ age })
                      : version.createdBy
                        ? m.projects_files_created_by({ age, name: version.createdBy })
                        : age,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </div>
              <a
                href={downloadHref(version.id)}
                download={file.name}
                className={buttonVariants({ size: "icon-sm", variant: "ghost" })}
                aria-label={m.projects_files_download_version({ number: version.number })}
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
                        aria-label={m.projects_files_version_actions({ number: version.number })}
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
                        {m.projects_files_restore()}
                      </DropdownMenuItem>
                    )}
                    {version.pinned ? (
                      <DropdownMenuItem
                        disabled={unpin.isPending}
                        onClick={() => unpin.mutate(version)}
                      >
                        <HugeiconsIcon icon={PinOffIcon} strokeWidth={2} />
                        {m.projects_files_unpin()}
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem onClick={() => setPinning(version)}>
                        <HugeiconsIcon icon={PinIcon} strokeWidth={2} />
                        {m.projects_files_pin_menu()}
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
    onError: (error) => toastError(m.projects_files_pin_failed(), error),
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
          <DialogTitle>
            {version
              ? m.projects_files_pin_title_number({ number: version.number })
              : m.projects_files_pin_title()}
          </DialogTitle>
          <DialogDescription>
            {m.projects_files_pin_description({ max: PROJECT_FILE_LIMITS.pinsPerFile })}
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
            <FieldLabel htmlFor={`${id}-label`}>{m.projects_files_pin_label()}</FieldLabel>
            <Input
              id={`${id}-label`}
              value={label}
              maxLength={80}
              onChange={(event) => setLabel(event.target.value)}
              placeholder={m.projects_files_pin_placeholder()}
              disabled={pin.isPending}
              autoFocus
            />
            <FieldDescription>{m.projects_files_pin_hint()}</FieldDescription>
          </Field>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={pin.isPending} />}>
              {m.common_cancel()}
            </DialogClose>
            <PendingButton type="submit" pending={pin.isPending}>
              {m.projects_files_pin()}
            </PendingButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
