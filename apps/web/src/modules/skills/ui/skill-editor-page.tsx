import {
  Delete02Icon,
  Download04Icon,
  File02Icon,
  MoreHorizontalIcon,
  RefreshIcon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useBlocker, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { AccessDialog } from "~/modules/sharing/ui/access-dialog.tsx";
import { capabilitiesQuery } from "~/modules/groups/client/queries.ts";
import { useConfirm } from "~/ui/confirm-context.ts";
import { SaveLabel, SaveStatus } from "~/ui/save-status.tsx";
import { useSaveStatus } from "~/ui/use-save-status.ts";
import { ErrorState, ListSkeleton, Page } from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Button, buttonVariants } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { skillDetailQuery, skillQuery } from "../client/queries.ts";
import { exportSkillArchive } from "../archive.ts";
import {
  isBinarySkillFile,
  NEW_SKILL_FILES,
  SkillPackageError,
  validateSkillPackage,
  type SkillBinaryFile,
  type SkillFile,
} from "../package.ts";
import type { SkillDetail } from "../schema.ts";
import { deleteSkill, saveSkill } from "../server/functions.ts";
import { skillFileInput, uploadSkillFile } from "../client/files.ts";
import { SkillUpdateReview } from "./skill-update-review.tsx";
import { PackageWorkspace } from "./package-workspace.tsx";
import type { AttachmentPreviewTarget } from "~/modules/attachments/ui/attachment-preview.tsx";
import { officePreview, type OfficeFile } from "~/modules/attachments/ui/office-preview.ts";
import { SkillSimpleForm } from "./skill-simple-form.tsx";
import { canEditSimply } from "./can-edit-simply.ts";
import { SegmentedControl, SegmentedControlItem } from "~/ui/segmented-control.tsx";
import { toastError } from "~/ui/error-toast.ts";
import { m } from "~/paraglide/messages.js";

/** A just-uploaded file reads back through its upload; a saved one through the skill. */
const binaryHref = (skillId: string | undefined, file: SkillBinaryFile) =>
  file.binary.uploadId
    ? `/api/files/${file.binary.uploadId}`
    : skillId && file.binary.sha256
      ? `/api/skills/${skillId}/files?sha256=${file.binary.sha256}`
      : null;

/**
 * The shared preview of a skill's binary file. A stored one downloads as opaque
 * bytes and never renders on this origin, so only server-rendered Office
 * previews apply; a fresh upload is an ordinary attachment until saved.
 */
function binaryPreview(
  skillId: string | undefined,
  file: SkillBinaryFile,
): AttachmentPreviewTarget | null {
  const url = binaryHref(skillId, file);
  const fileName = file.path.slice(file.path.lastIndexOf("/") + 1);
  const source: OfficeFile | null = file.binary.uploadId
    ? { kind: "attachment", id: file.binary.uploadId }
    : skillId && file.binary.sha256
      ? { kind: "skill-file", id: `${skillId}:${file.binary.sha256}` }
      : null;
  const office = source && officePreview({ fileName, mediaType: file.binary.mediaType }, source);
  return url && office ? { fileName, size: file.binary.size, kind: "file", url, office } : null;
}

function download(name: string, bytes: Uint8Array | string, type: string) {
  const url = URL.createObjectURL(
    new Blob([typeof bytes === "string" ? bytes : new Uint8Array(bytes)], { type }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function SkillEditorPage({ skillId }: { skillId?: string }) {
  const { data: capabilities } = useQuery(capabilitiesQuery);
  const metadata = useQuery({ ...skillQuery(skillId ?? ""), enabled: !!skillId, retry: false });
  const detail = useQuery({
    ...skillDetailQuery(skillId ?? ""),
    enabled: !!skillId && metadata.data?.canEdit === true && !!capabilities?.skillsCreate,
    retry: false,
  });
  if (!skillId && capabilities?.skillsCreate) return <OwnerEditor />;
  if (!skillId)
    return (
      <Page title={m.skills_editor_new()} backTo="/skills" backLabel={m.skills_title()}>
        <p className="text-muted-foreground text-sm">{m.skills_editor_cannot_create()}</p>
      </Page>
    );
  if ((metadata.isError && !metadata.data) || (detail.isError && !detail.data))
    return (
      <Page title={m.skills_editor_title()} backTo="/skills" backLabel={m.skills_title()}>
        <ErrorState
          title={m.skills_editor_load_failed()}
          onRetry={() => {
            void metadata.refetch();
            if (metadata.data?.canEdit && capabilities?.skillsCreate) void detail.refetch();
          }}
        />
      </Page>
    );
  if (!metadata.data)
    return (
      <Page title={m.skills_editor_title()} backTo="/skills" backLabel={m.skills_title()}>
        <ListSkeleton rows={1} media="none" label={m.skills_editor_loading()} />
      </Page>
    );
  if (!metadata.data.canEdit || !capabilities?.skillsCreate)
    return (
      <Page title={metadata.data.name} backTo="/skills" backLabel={m.skills_title()}>
        <p className="text-muted-foreground text-sm">{metadata.data.description}</p>
        <p className="text-muted-foreground text-xs">
          {metadata.data.ownerName
            ? m.skills_editor_shared_by({ name: metadata.data.ownerName })
            : m.skills_editor_read_only()}
        </p>
        <Link to="/" search={{ skill: skillId }} className={buttonVariants({ size: "sm" })}>
          {m.skills_editor_use_in_chat()}
        </Link>
      </Page>
    );
  return detail.data ? (
    <OwnerEditor key={skillId} initial={detail.data} />
  ) : (
    <Page title={metadata.data.name} backTo="/skills" backLabel={m.skills_title()}>
      <ListSkeleton rows={3} media="none" label={m.skills_editor_loading_files()} />
    </Page>
  );
}

function OwnerEditor({ initial }: { initial?: SkillDetail }) {
  const confirm = useConfirm();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [files, setFiles] = useState<SkillFile[]>(
    () => initial?.files ?? NEW_SKILL_FILES.map((file) => ({ ...file })),
  );
  const [saved, setSaved] = useState(() => JSON.stringify(initial?.files ?? NEW_SKILL_FILES));
  const [revision, setRevision] = useState(initial?.revision);
  const [access, setAccess] = useState(false);
  const [updating, setUpdating] = useState(false);
  // Most people only ever need the simple form; a skill whose SKILL.md it can't
  // read opens in advanced mode, and simple stays unavailable until that's fixed.
  const [view, setView] = useState<"form" | "files">(() =>
    canEditSimply(initial?.files ?? NEW_SKILL_FILES) ? "form" : "files",
  );
  const formAvailable = canEditSimply(files);
  const dirty = JSON.stringify(files) !== saved;
  const { justSaved, markSaved } = useSaveStatus();
  useBlocker({
    shouldBlockFn: async () =>
      dirty &&
      !(await confirm({
        title: m.common_discard_title(),
        description: m.skills_editor_unsaved_description(),
        confirmLabel: m.common_discard_changes(),
      })),
    enableBeforeUnload: dirty,
  });
  const validation = (() => {
    try {
      return { value: validateSkillPackage(files), error: null };
    } catch (error) {
      return {
        value: null,
        error:
          error instanceof SkillPackageError
            ? error
            : new SkillPackageError([
                {
                  severity: "error",
                  path: "SKILL.md",
                  code: "unreadable",
                  message: "This skill can’t be read.",
                },
              ]),
      };
    }
  })();
  const findings = validation.value?.findings ?? validation.error?.findings ?? [];
  const save = useMutation({
    mutationFn: (submitted: SkillFile[]) =>
      saveSkill({
        data: {
          files: submitted.map(skillFileInput),
          ...(initial ? { skillId: initial.id, expectedRevision: revision! } : {}),
        },
      }),
    onSuccess: async (accepted, submitted) => {
      const byPath = new Map(accepted.files.map((file) => [file.path, file]));
      const uploads = new Map<string, SkillBinaryFile>();
      for (const file of submitted) {
        if (!isBinarySkillFile(file) || !file.binary.uploadId) continue;
        const stored = byPath.get(file.path);
        if (stored && isBinarySkillFile(stored)) uploads.set(file.binary.uploadId, stored);
      }
      setSaved(JSON.stringify(submitted.map((file) => byPath.get(file.path)!)));
      setRevision(accepted.revision);
      setFiles((current) =>
        current.map((file) => {
          if (!isBinarySkillFile(file) || !file.binary.uploadId) return file;
          const stored = uploads.get(file.binary.uploadId);
          return stored ? { ...file, binary: stored.binary } : file;
        }),
      );
      // Stored identities arrive with the save, before any latest-detail refresh.
      if (initial) markSaved();
      await queryClient.invalidateQueries({ queryKey: ["skills"] });
      if (!initial)
        await navigate({
          to: "/skills/$skillId",
          params: { skillId: accepted.id },
          ignoreBlocker: true,
        });
    },
    onError: () => toast.error(m.skills_editor_save_failed()),
  });
  const remove = useMutation({
    mutationFn: () => deleteSkill({ data: { skillId: initial!.id } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["skills"] });
      await navigate({ to: "/skills", ignoreBlocker: true });
    },
    onError: (error) => toastError(m.skills_editor_delete_failed(), error),
  });
  if (updating && initial)
    return (
      <SkillUpdateReview
        skillId={initial.id}
        onBack={() => setUpdating(false)}
        onApplied={(nextFiles, nextRevision) => {
          setFiles(nextFiles);
          setSaved(JSON.stringify(nextFiles));
          setRevision(nextRevision);
          setUpdating(false);
          void queryClient.invalidateQueries({ queryKey: ["skills"] });
          markSaved();
        }}
      />
    );
  return (
    <Page
      title={validation.value?.metadata.name ?? initial?.name ?? m.skills_editor_new()}
      backTo="/skills"
      backLabel={m.skills_title()}
      actions={
        <>
          <SaveStatus justSaved={justSaved} />
          {initial ? (
            <Button size="sm" variant="outline" onClick={() => setAccess(true)}>
              <HugeiconsIcon icon={UserGroupIcon} strokeWidth={2} data-icon="inline-start" />
              {m.skills_editor_access()}
            </Button>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button size="icon-sm" variant="ghost" aria-label={m.skills_editor_actions()} />
              }
            >
              <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {initial?.source ? (
                <DropdownMenuItem
                  disabled={dirty || save.isPending}
                  onClick={() => setUpdating(true)}
                >
                  <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />
                  {dirty
                    ? m.skills_editor_check_updates_save_first()
                    : m.skills_editor_check_updates()}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem
                disabled={!validation.value}
                onClick={async () => {
                  try {
                    const loaded = await Promise.all(
                      files.map(async (file) => {
                        if (!isBinarySkillFile(file)) return file;
                        const href = binaryHref(initial?.id, file);
                        const response = href ? await fetch(href) : null;
                        if (!response?.ok)
                          throw new Error(m.skills_editor_file_not_loaded({ path: file.path }));
                        return { ...file, bytes: new Uint8Array(await response.arrayBuffer()) };
                      }),
                    );
                    download(
                      `${validation.value!.metadata.name}.zip`,
                      exportSkillArchive(loaded),
                      "application/zip",
                    );
                  } catch (error) {
                    toastError(m.skills_editor_export_failed(), error);
                  }
                }}
              >
                <HugeiconsIcon icon={Download04Icon} strokeWidth={2} />
                {m.skills_editor_export_zip()}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  download(
                    "SKILL.md",
                    ((root) => (root && !isBinarySkillFile(root) ? root.content : ""))(
                      files.find((file) => file.path === "SKILL.md"),
                    ),
                    "text/markdown",
                  );
                  toast.info(m.skills_editor_markdown_only());
                }}
              >
                <HugeiconsIcon icon={File02Icon} strokeWidth={2} />
                {m.skills_editor_export_markdown()}
              </DropdownMenuItem>
              {initial ? (
                <DropdownMenuItem
                  variant="destructive"
                  disabled={remove.isPending}
                  onClick={async () => {
                    if (
                      await confirm({
                        title: m.skills_editor_delete_title({ name: initial.name }),
                        description: m.skills_editor_delete_description(),
                        confirmLabel: m.skills_editor_delete(),
                      })
                    )
                      remove.mutate();
                  }}
                >
                  <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                  {m.skills_editor_delete()}
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
          <PendingButton
            size="sm"
            pending={save.isPending}
            disabled={!validation.value || (!!initial && !dirty)}
            onClick={() => save.mutate(files.map((file) => ({ ...file })))}
          >
            <SaveLabel justSaved={justSaved}>
              {initial ? m.common_save_changes() : m.skills_editor_create()}
            </SaveLabel>
          </PendingButton>
        </>
      }
    >
      <SegmentedControl
        aria-label={m.skills_editor_mode()}
        value={[view === "form" && formAvailable ? "form" : "files"]}
        multiple={false}
        onValueChange={(value) => {
          if (value[0] === "form" || value[0] === "files") setView(value[0]);
        }}
        className="self-start"
      >
        <SegmentedControlItem value="form" disabled={!formAvailable}>
          {m.skills_editor_simple()}
        </SegmentedControlItem>
        <SegmentedControlItem value="files">{m.skills_editor_advanced()}</SegmentedControlItem>
      </SegmentedControl>
      {view === "form" && formAvailable ? (
        <SkillSimpleForm
          autoFocus={!initial}
          files={files}
          onChange={!save.isPending || initial ? setFiles : undefined}
          findings={findings}
        />
      ) : (
        <PackageWorkspace
          autoFocus={!initial}
          files={files}
          {...(!save.isPending || initial ? { onChange: setFiles } : {})}
          findings={findings}
          upload={uploadSkillFile}
          downloadHref={(file) => binaryHref(initial?.id, file)}
          preview={(file) => binaryPreview(initial?.id, file)}
        />
      )}
      {initial ? (
        <AccessDialog
          resource={{ kind: "skill", id: initial.id }}
          title={initial.name}
          open={access}
          onOpenChange={setAccess}
        />
      ) : null}
    </Page>
  );
}
