import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { ErrorState, ListSkeleton, Page, Section } from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Button } from "~/ui/primitives/button";
import { applySkillUpdate, reviewSkillUpdate } from "../server/import-functions.ts";
import { resolveSkillUpdate } from "../update.ts";
import {
  isBinarySkillFile,
  SkillPackageError,
  validateSkillPackage,
  type SkillFile,
} from "../package.ts";
import { formatFileSize } from "~/modules/attachments/constants.ts";
import { PackageWorkspace } from "./package-workspace.tsx";
import { formatLocale } from "~/i18n/formats.ts";
import { m } from "~/paraglide/messages.js";

type Review = Awaited<ReturnType<typeof reviewSkillUpdate>>;
export function SkillUpdateReview({
  skillId,
  onBack,
  onApplied,
}: {
  skillId: string;
  onBack: () => void;
  onApplied: (files: SkillFile[], revision: number) => void;
}) {
  const review = useQuery({
    queryKey: ["skills", skillId, "update-review"],
    queryFn: ({ signal }) => reviewSkillUpdate({ data: { skillId }, signal }),
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  if (review.data)
    return (
      <ReviewFiles
        key={review.data.source.commit}
        skillId={skillId}
        review={review.data}
        onBack={onBack}
        onApplied={onApplied}
      />
    );
  return (
    <Page title={m.skills_update_title()} onBack={onBack} backLabel={m.skills_update_back()}>
      {review.isError ? (
        <ErrorState
          title={m.skills_update_failed()}
          description={m.skills_update_failed_description()}
          onRetry={() => void review.refetch()}
        />
      ) : (
        <ListSkeleton rows={2} media="none" label={m.skills_update_reading()} />
      )}
    </Page>
  );
}
function ReviewFiles({
  skillId,
  review,
  onBack,
  onApplied,
}: {
  skillId: string;
  review: Review;
  onBack: () => void;
  onApplied: (files: SkillFile[], revision: number) => void;
}) {
  const [changes, setChanges] = useState(review.changes);
  const files = resolveSkillUpdate(changes);
  let findings;
  let valid = true;
  try {
    findings = validateSkillPackage(files).findings;
  } catch (error) {
    valid = false;
    findings = error instanceof SkillPackageError ? error.findings : [];
  }
  const apply = useMutation({
    mutationFn: () =>
      applySkillUpdate({
        data: {
          skillId,
          expectedRevision: review.expectedRevision,
          source: {
            repository: review.source.repository,
            commit: review.source.commit,
            path: review.source.path,
            contentHash: review.source.contentHash,
          },
          choices: changes.map(({ path, selected }) => ({ path, selected })),
        },
      }),
    onSuccess: (result) => onApplied(result.files, result.revision),
    onError: () => toast.error(m.skills_update_apply_failed()),
  });
  const changed = changes.filter(
    (change) => change.local !== change.upstream || change.baseline !== change.upstream,
  );
  return (
    <Page
      title={m.skills_update_review_title()}
      onBack={onBack}
      backLabel={m.skills_update_back()}
      actions={
        <PendingButton
          size="sm"
          pending={apply.isPending}
          disabled={!valid}
          onClick={() => apply.mutate()}
        >
          {m.skills_update_apply()}
        </PendingButton>
      }
    >
      <p className="text-muted-foreground text-xs break-all">
        {m.skills_update_from({
          source: `${review.source.repository}/${review.source.path || ""}`,
          commit: review.source.commit.slice(0, 7),
        })}
      </p>
      <Section
        title={m.skills_update_changes()}
        description={m.skills_update_changes_description()}
      >
        {changed.length === 0 ? (
          <p className="text-muted-foreground text-sm">{m.skills_update_nothing()}</p>
        ) : (
          changed.map((change) => (
            <details key={change.path} className="border-border rounded-3xl border p-4">
              <summary className="cursor-pointer break-all text-sm font-medium">
                {change.conflict
                  ? m.skills_update_changed_both({ path: change.path })
                  : change.path}
              </summary>
              <div className="mt-3 grid min-w-0 gap-3 md:grid-cols-2">
                {(["local", "upstream"] as const).map((side) => (
                  <div key={side} className="min-w-0 space-y-2">
                    <Button
                      size="sm"
                      variant={change.selected === side ? "secondary" : "outline"}
                      aria-pressed={change.selected === side}
                      disabled={apply.isPending}
                      onClick={() =>
                        setChanges((current) =>
                          current.map((file) =>
                            file.path === change.path ? { ...file, selected: side } : file,
                          ),
                        )
                      }
                    >
                      {side === "local"
                        ? m.skills_update_keep_mine()
                        : m.skills_update_use_theirs()}
                    </Button>
                    <pre className="text-muted-foreground max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-2xl bg-muted p-3 text-xs">
                      {describeSide(change[side])}
                    </pre>
                  </div>
                ))}
              </div>
            </details>
          ))
        )}
      </Section>
      <Section title={m.skills_update_after()} description={m.skills_update_after_description()}>
        <PackageWorkspace files={files} findings={findings} />
      </Section>
    </Page>
  );
}

/** A binary side is named by type and size; its bytes never reach the browser. */
function describeSide(file: SkillFile | null) {
  if (!file) return m.skills_update_file_deleted();
  if (!isBinarySkillFile(file)) return file.content;
  return m.skills_update_binary({
    type: file.binary.mediaType,
    size: formatFileSize(file.binary.size, formatLocale()),
  });
}
