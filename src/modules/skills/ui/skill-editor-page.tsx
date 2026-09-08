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
import { useConfirm } from "~/ui/confirm.tsx";
import { ErrorState, Page } from "~/ui/page-shell.tsx";
import { Button, buttonVariants } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { Spinner } from "~/ui/primitives/spinner";
import { skillDetailQuery, skillQuery } from "../client/queries.ts";
import { exportSkillArchive } from "../archive.ts";
import {
  NEW_SKILL_FILES,
  SkillPackageError,
  validateSkillPackage,
  type SkillFile,
} from "../package.ts";
import type { SkillDetail } from "../schema.ts";
import { deleteSkill, saveSkill } from "../server/functions.ts";
import { SkillUpdateReview } from "./skill-update-review.tsx";
import { PackageWorkspace } from "./package-workspace.tsx";

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
  const metadata = useQuery({ ...skillQuery(skillId ?? ""), enabled: !!skillId, retry: false });
  const detail = useQuery({
    ...skillDetailQuery(skillId ?? ""),
    enabled: !!skillId && metadata.data?.canEdit === true,
    retry: false,
  });
  if (!skillId) return <OwnerEditor />;
  if (metadata.isError || detail.isError)
    return (
      <Page title="Skill" backTo="/skills" backLabel="Skills">
        <ErrorState
          title="Skill not available"
          onRetry={() => {
            void metadata.refetch();
            if (metadata.data?.canEdit) void detail.refetch();
          }}
        />
      </Page>
    );
  if (!metadata.data)
    return (
      <Page title="Skill" backTo="/skills" backLabel="Skills">
        <p className="text-muted-foreground text-sm">Loading skill…</p>
      </Page>
    );
  if (!metadata.data.canEdit)
    return (
      <Page title={metadata.data.name} backTo="/skills" backLabel="Skills">
        <p className="text-muted-foreground text-sm">{metadata.data.description}</p>
        <p className="text-muted-foreground text-xs">
          Shared by {metadata.data.ownerName}. You can use this skill, but only its owner can view
          or edit its files.
        </p>
        <Link to="/" search={{ skill: skillId }} className={buttonVariants({ size: "sm" })}>
          Use in chat
        </Link>
      </Page>
    );
  return detail.data ? (
    <OwnerEditor key={skillId} initial={detail.data} />
  ) : (
    <Page title={metadata.data.name} backTo="/skills" backLabel="Skills">
      <p className="text-muted-foreground text-sm">Loading files…</p>
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
  const dirty = JSON.stringify(files) !== saved;
  useBlocker({
    shouldBlockFn: async () =>
      dirty &&
      !(await confirm({
        title: "Discard unsaved changes?",
        description: "Your skill draft has not been saved.",
        confirmLabel: "Discard changes",
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
                { severity: "error", path: "SKILL.md", message: "Invalid package." },
              ]),
      };
    }
  })();
  const save = useMutation({
    mutationFn: (submitted: SkillFile[]) =>
      saveSkill({
        data: {
          files: submitted,
          ...(initial ? { skillId: initial.id, expectedRevision: revision! } : {}),
        },
      }),
    onSuccess: async (id, submitted) => {
      setSaved(JSON.stringify(submitted));
      setRevision((current) => (current ?? 0) + 1);
      await queryClient.invalidateQueries({ queryKey: ["skills"] });
      toast.success("Skill saved.");
      if (!initial)
        await navigate({ to: "/skills/$skillId", params: { skillId: id }, ignoreBlocker: true });
    },
    onError: () =>
      toast.error(
        "Could not save this revision. Your draft is preserved; another editor may have changed the skill.",
      ),
  });
  const remove = useMutation({
    mutationFn: () => deleteSkill({ data: { skillId: initial!.id } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["skills"] });
      await navigate({ to: "/skills", ignoreBlocker: true });
    },
    onError: () => toast.error("Could not delete the skill."),
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
          toast.success("Skill updated.");
        }}
      />
    );
  return (
    <Page
      title={validation.value?.metadata.name ?? initial?.name ?? "Create skill"}
      backTo="/skills"
      backLabel="Skills"
      actions={
        <>
          {dirty ? <span className="text-muted-foreground text-xs">Unsaved changes</span> : null}
          {initial ? (
            <Button size="sm" variant="outline" onClick={() => setAccess(true)}>
              <HugeiconsIcon icon={UserGroupIcon} strokeWidth={2} data-icon="inline-start" />
              Access
            </Button>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button size="icon-sm" variant="ghost" aria-label="Skill actions" />}
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
                  Check for updates{dirty ? " — save first" : ""}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem
                disabled={!validation.value}
                onClick={() =>
                  download(
                    `${validation.value!.metadata.name}.zip`,
                    exportSkillArchive(files),
                    "application/zip",
                  )
                }
              >
                <HugeiconsIcon icon={Download04Icon} strokeWidth={2} />
                Export ZIP
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  download(
                    "SKILL.md",
                    files.find((file) => file.path === "SKILL.md")?.content ?? "",
                    "text/markdown",
                  );
                  toast.info("Markdown export excludes supporting files.");
                }}
              >
                <HugeiconsIcon icon={File02Icon} strokeWidth={2} />
                Export Markdown
              </DropdownMenuItem>
              {initial ? (
                <DropdownMenuItem
                  variant="destructive"
                  disabled={remove.isPending}
                  onClick={async () => {
                    if (
                      await confirm({
                        title: "Delete this skill?",
                        description:
                          "Chats that used it stay readable, but it can no longer be used or selected.",
                        confirmLabel: "Delete skill",
                      })
                    )
                      remove.mutate();
                  }}
                >
                  <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                  Delete skill
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            size="sm"
            disabled={!validation.value || save.isPending || (!!initial && !dirty)}
            aria-busy={save.isPending}
            onClick={() => save.mutate(files.map((file) => ({ ...file })))}
          >
            {save.isPending ? <Spinner aria-hidden data-icon="inline-start" /> : null}Save
          </Button>
        </>
      }
    >
      <PackageWorkspace
        autoFocus={!initial}
        files={files}
        {...(!save.isPending || initial ? { onChange: setFiles } : {})}
        findings={validation.value?.findings ?? validation.error?.findings ?? []}
      />
      <p className="text-muted-foreground text-xs">
        A skill is instructions, not access — files here are stored and read, never run. Anyone you
        share it with can see its instructions.
      </p>
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
