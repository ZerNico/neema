import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { ErrorState, ListSkeleton, Page, Section } from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Button } from "~/ui/primitives/button";
import { applySkillUpdate, reviewSkillUpdate } from "../server/import-functions.ts";
import { resolveSkillUpdate } from "../update.ts";
import { SkillPackageError, validateSkillPackage, type SkillFile } from "../package.ts";
import { PackageWorkspace } from "./package-workspace.tsx";

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
    <Page title="Check for updates" onBack={onBack} backLabel="Editor">
      {review.isError ? (
        <ErrorState
          title="Could not check for updates"
          description="Nothing was changed. The source may be unavailable, or too many requests were made just now."
          onRetry={() => void review.refetch()}
        />
      ) : (
        <ListSkeleton rows={2} media="none" label="Reading the latest version" />
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
    onError: () =>
      toast.error(
        "Could not update the skill. Your choices are kept, but if it changed somewhere else in the meantime, go back and check again.",
      ),
  });
  const changed = changes.filter(
    (change) => change.local !== change.upstream || change.baseline !== change.upstream,
  );
  return (
    <Page
      title="Review skill update"
      onBack={onBack}
      backLabel="Editor"
      actions={
        <PendingButton
          size="sm"
          pending={apply.isPending}
          disabled={!valid}
          onClick={() => apply.mutate()}
        >
          Update skill
        </PendingButton>
      }
    >
      <p className="text-muted-foreground text-xs break-all">
        From {review.source.repository}/{review.source.path || ""} ·{" "}
        {review.source.commit.slice(0, 7)}
      </p>
      <Section
        title="What changed"
        description="Your version is kept unless you pick the new one. Whole files are swapped; the two are never mixed together."
      >
        {changed.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Nothing to update, your files match the latest version.
          </p>
        ) : (
          changed.map((change) => (
            <details key={change.path} className="border-border rounded-3xl border p-4">
              <summary className="cursor-pointer break-all text-sm font-medium">
                {change.path}
                {change.conflict ? " · changed on both sides" : ""}
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
                      {side === "local" ? "Keep mine" : "Use theirs"}
                    </Button>
                    <pre className="text-muted-foreground max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-2xl bg-muted p-3 text-xs">
                      {change[side] ?? "File deleted"}
                    </pre>
                  </div>
                ))}
              </div>
            </details>
          ))
        )}
      </Section>
      <Section
        title="The skill after updating"
        description="Check it over before applying. Files you keep won’t be raised again until they change again."
      >
        <PackageWorkspace files={files} findings={findings} />
      </Section>
    </Page>
  );
}
