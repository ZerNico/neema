import { CodeIcon } from "@hugeicons/core-free-icons";
import { useState } from "react";
import type { CustomToolActivity } from "../client/use-message-stream.ts";
import { Disclosure, DisclosureContent, DisclosureTrigger } from "~/ui/disclosure.tsx";
import {
  disclosureBodyRailClassName,
  disclosureTriggerClassName,
} from "~/ui/disclosure-classes.ts";
import { cn } from "~/ui/utils";
import { ActivityChevron, ActivityFace, ActivityNote } from "./activity-face.tsx";
import { activityRowClassName } from "./activity-row.ts";
import { workingFileState } from "./working-file-state.ts";

/**
 * One admin-authored code tool call. The row carries the tool's display name
 * and status; the result preview sits behind a disclosure, since the full
 * output already went to the model and is never retransmitted here. Working
 * files show their lifecycle; published attachments render after this row, not
 * as a second chip inside it.
 */
export function CustomToolActivityBlock({
  activity,
  terminal = false,
  published,
}: {
  activity: CustomToolActivity;
  /** The answer has ended, so an unpublished file stays a draft. */
  terminal?: boolean;
  /** Working files some publish in this answer delivered. */
  published?: ReadonlySet<string>;
}) {
  const [open, setOpen] = useState(false);
  const running = activity.status === "running";
  const failed = activity.status === "error";
  const status = running ? "running" : failed ? "failed" : "done";
  const label = running
    ? `Running ${activity.displayName}`
    : failed
      ? `Couldn’t run ${activity.displayName}`
      : `Ran ${activity.displayName}`;
  const workingFiles = (activity.workingFiles ?? []).map((file) => ({
    file,
    state: workingFileState(published?.has(file.id) ?? false, terminal),
  }));
  const workingState = !workingFiles.length
    ? null
    : workingFiles.every(({ state }) => state === "Published")
      ? "Published"
      : workingFileState(false, terminal);

  if (!activity.resultPreview && !activity.error && !workingFiles.length)
    return (
      <div className={cn(activityRowClassName, "mb-2")}>
        <ActivityFace icon={CodeIcon} label={label} status={status} />
      </div>
    );

  return (
    <Disclosure open={open} onOpenChange={setOpen} className="mb-2">
      <DisclosureTrigger className={disclosureTriggerClassName}>
        <ActivityFace icon={CodeIcon} label={label} detail={workingState} status={status} />
        <ActivityChevron open={open} />
      </DisclosureTrigger>
      <DisclosureContent>
        <div className={disclosureBodyRailClassName}>
          {failed && activity.error ? <ActivityNote>{activity.error}</ActivityNote> : null}
          {workingFiles.map(({ file, state }) => (
            <p
              key={`${file.id}@${file.revision}`}
              className="text-muted-foreground text-xs [overflow-wrap:anywhere]"
            >
              {file.name} · {state}
            </p>
          ))}
          {activity.resultPreview ? (
            <p className="text-muted-foreground text-xs [overflow-wrap:anywhere] whitespace-pre-wrap">
              {activity.resultPreview}
              {activity.resultChars !== undefined &&
              activity.resultChars > activity.resultPreview.length
                ? ` (${activity.resultChars} chars)`
                : ""}
            </p>
          ) : null}
        </div>
      </DisclosureContent>
    </Disclosure>
  );
}
