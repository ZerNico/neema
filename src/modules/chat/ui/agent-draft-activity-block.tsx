import { ArrowRight01Icon, PencilEdit02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useAgentDraftPanel } from "~/modules/agents/ui/agent-draft-owner.tsx";
import type { AgentDraftToolActivity } from "../client/use-message-stream.ts";
import { Button } from "~/ui/primitives/button";
import { cn } from "~/ui/utils";
import { activityRowClassName } from "./activity-row.ts";

/**
 * Only rows without a draft reference reach this: anything naming a draft
 * renders the widget instead, so the outcomes here are the ones that touched
 * no draft at all.
 */
export function agentDraftActivityLabel(activity: AgentDraftToolActivity) {
  if (activity.status === "running") {
    if (activity.name === "draft_agent") return "Preparing agent draft…";
    return activity.name === "update_agent_draft"
      ? "Updating agent draft…"
      : "Checking agent settings…";
  }
  return activity.result?.outcome === "options"
    ? "Checked available options"
    : "Agent draft not updated";
}

/** Also used as an inline recovery entry if a retry removes the original tool row. */
export function AgentDraftWidget({ draftId }: { draftId: string }) {
  // A branch keeps the originating reference. Its draft belongs to the other
  // conversation, so it is absent from this owner and stays inert.
  const { owned, entry } = useAgentDraftPanel(draftId);
  const current = entry;
  const contents = (
    <>
      <HugeiconsIcon
        icon={PencilEdit02Icon}
        strokeWidth={2}
        className="size-4 shrink-0"
        aria-hidden
      />
      <span className="min-w-0 flex-1 text-left">
        <span className="block text-sm font-medium">Agent draft</span>
        <span className="text-muted-foreground block truncate text-xs">
          {current
            ? [current.name, current.status].filter(Boolean).join(" · ")
            : owned
              ? "Loading draft…"
              : "From another chat"}
        </span>
      </span>
      {current?.open ? (
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          strokeWidth={2}
          className="size-4 shrink-0"
          aria-hidden
        />
      ) : null}
    </>
  );
  const className =
    "mb-3 flex h-auto w-full max-w-sm items-center gap-3 rounded-xl border px-3 py-2.5";
  if (current?.open)
    return (
      <Button
        variant="outline"
        className={className}
        aria-label={`Open agent draft: ${current.name}`}
        aria-expanded={current.expanded}
        onClick={current.open}
      >
        {contents}
      </Button>
    );
  return (
    <div className={className}>
      {contents}
      {current?.retry ? (
        <Button size="sm" variant="ghost" onClick={current.retry}>
          Retry loading draft
        </Button>
      ) : null}
    </div>
  );
}

export function AgentDraftActivityBlock({ activity }: { activity: AgentDraftToolActivity }) {
  const reference = activity.result?.draftId;
  if (reference) return <AgentDraftWidget draftId={reference} />;
  return (
    <div className={cn(activityRowClassName, "mb-2")}>
      <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} className="size-4" aria-hidden />
      {/* The stored reason is for debugging (message_tool_calls.error), not the reader. */}
      <span className={cn(activity.status === "running" && "text-shimmer")}>
        {agentDraftActivityLabel(activity)}
      </span>
    </div>
  );
}
