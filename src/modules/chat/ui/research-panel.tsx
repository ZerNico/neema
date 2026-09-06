import { Alert02Icon, Search01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useMemo } from "react";
import type { ResearchToolActivity, WebToolActivity } from "../client/use-message-stream.ts";
import type { ResearchProgress, ResearchTaskProgress } from "../research-schema.ts";
import { Favicon, hostOf } from "./favicon.tsx";
import type { DisplayMessage } from "./message-list.tsx";
import {
  useDetailPanel,
  useDetailPanelSelectedId,
  type DetailPanelRequest,
} from "~/ui/detail-panel";
import { Spinner } from "~/ui/primitives/spinner.tsx";
import { cn } from "~/ui/utils";

// The transcript row stays one line; this is where the rest lives: what the
// run did, in order, grouped by the task it was doing it for. The sources
// panel is a separate view with its own entry points (citation chips, the
// message menu); the plan is the model's working note and stays internal.

const taskLabels: Record<ResearchTaskProgress["status"], string> = {
  queued: "Queued",
  running: "Investigating",
  complete: "Done",
  error: "Failed",
  aborted: "Stopped",
};

interface ActivityItem {
  key: string;
  label: string;
  url?: string;
}

const describe = (activity: WebToolActivity): { verb: string; items: ActivityItem[] } => {
  const targets = activity.targets.map((target) => target.trim()).filter(Boolean);
  if (activity.name === "read_url")
    return {
      verb: activity.status === "running" ? "Reading" : "Read",
      items: targets.map((url) => ({ key: url, label: hostOf(url), url })),
    };
  return {
    verb: activity.status === "running" ? "Searching" : "Searched",
    items: targets.map((query) => ({ key: query, label: `“${query}”` })),
  };
};

function ActivityRow({ activity }: { activity: WebToolActivity }) {
  const { verb, items } = describe(activity);
  const failed = activity.status === "error";
  return (
    <li className="flex min-w-0 gap-2 py-1 text-xs leading-relaxed">
      {/* h-lh: exactly one line of the text beside it, so the icon centres on
          the first line whatever the font metrics. */}
      <span className="flex h-lh shrink-0 items-center">
        {activity.status === "running" ? (
          <Spinner aria-hidden className="text-muted-foreground size-3.5" />
        ) : failed ? (
          <HugeiconsIcon icon={Alert02Icon} className="text-warning size-3.5" aria-hidden />
        ) : activity.name === "read_url" ? (
          <HugeiconsIcon icon={Tick02Icon} className="text-success size-3.5" aria-hidden />
        ) : (
          <HugeiconsIcon
            icon={Search01Icon}
            className="text-muted-foreground size-3.5"
            aria-hidden
          />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <span className="text-muted-foreground">{verb} </span>
        {items.map((item, index) => (
          <span key={item.key} className="[overflow-wrap:anywhere]">
            {index > 0 ? <span className="text-muted-foreground">, </span> : null}
            {item.url ? (
              <a
                href={item.url}
                target="_blank"
                rel="noreferrer noopener"
                className="hover:text-primary transition-colors"
              >
                {/* Inline, not inline-flex: a flex box's baseline would be the
                    image's bottom edge and push the label off the line. */}
                <Favicon
                  url={item.url}
                  className="mr-1 inline-block size-3 rounded-[3px] align-[-2px]"
                />
                {item.label}
              </a>
            ) : (
              <span className="text-foreground">{item.label}</span>
            )}
          </span>
        ))}
        {activity.resultCount !== undefined && activity.name !== "read_url" && !failed ? (
          <span className="text-muted-foreground/70"> · {activity.resultCount} results</span>
        ) : null}
      </div>
    </li>
  );
}

function TaskGroup({
  task,
  activities,
}: {
  task: ResearchTaskProgress | null;
  activities: WebToolActivity[];
}) {
  return (
    <section className="min-w-0">
      {task ? (
        <header className="flex items-baseline gap-2">
          <h3 className="min-w-0 flex-1 text-sm font-medium [overflow-wrap:anywhere]">
            {task.title}
          </h3>
          <span
            className={cn(
              "shrink-0 text-2xs uppercase tracking-wider",
              task.status === "error" ? "text-warning" : "text-muted-foreground",
            )}
          >
            {taskLabels[task.status]}
          </span>
        </header>
      ) : null}
      {task?.error ? <p className="text-warning mt-1 text-xs">{task.error}</p> : null}
      {activities.length > 0 ? (
        <ol className="mt-1 flex flex-col">
          {activities.map((activity) => (
            <ActivityRow key={activity.callId} activity={activity} />
          ))}
        </ol>
      ) : task?.status === "queued" || task?.status === "running" ? (
        <p className="text-muted-foreground mt-1 text-xs">Nothing yet.</p>
      ) : null}
    </section>
  );
}

export function ResearchActivityBody({
  progress,
  webActivities,
  running,
}: {
  progress: ResearchProgress | undefined;
  webActivities: WebToolActivity[];
  running: boolean;
}) {
  // Ordinal is dispatch order, which is what a reader expects to scroll through.
  // oxlint-disable-next-line no-array-sort -- fresh array
  const tasks = [...(progress?.tasks ?? [])].sort((a, b) => a.ordinal - b.ordinal);
  const byTask = new Map<string, WebToolActivity[]>();
  const unassigned: WebToolActivity[] = [];
  for (const activity of webActivities) {
    const list = activity.taskId ? byTask.get(activity.taskId) : undefined;
    if (activity.taskId && tasks.some((task) => task.id === activity.taskId)) {
      if (list) list.push(activity);
      else byTask.set(activity.taskId, [activity]);
    } else unassigned.push(activity);
  }
  const limitations = [...new Set(progress?.limitations ?? [])];
  const empty = tasks.length === 0 && unassigned.length === 0;

  return (
    <div className="flex flex-col gap-5">
      {empty ? (
        <p className="text-muted-foreground text-xs">
          {running ? "Planning what to investigate…" : "No investigation was recorded."}
        </p>
      ) : null}
      {tasks.map((task) => (
        <TaskGroup key={task.id} task={task} activities={byTask.get(task.id) ?? []} />
      ))}
      {unassigned.length > 0 ? <TaskGroup task={null} activities={unassigned} /> : null}
      {limitations.length > 0 ? (
        <section>
          <h3 className="text-muted-foreground mb-1 text-2xs font-medium tracking-wider uppercase">
            Limitations
          </h3>
          <ul className="text-warning list-disc space-y-1 pl-4 text-xs">
            {limitations.map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {progress && !progress.usageComplete && !running ? (
        <p className="text-muted-foreground text-xs">
          Some provider usage was not reported; recorded usage may be incomplete.
        </p>
      ) : null}
    </div>
  );
}

const researchPanelId = (messageId: string, runId: string) =>
  `research:${JSON.stringify([messageId, runId])}`;

const runIdOf = (activity: ResearchToolActivity) => activity.progress?.runId ?? activity.runId;

function researchPanelRequest(
  messageId: string,
  activity: ResearchToolActivity,
  webActivities: WebToolActivity[],
): DetailPanelRequest | null {
  const runId = runIdOf(activity);
  if (!runId) return null;
  const running = activity.status === "running" && activity.progress?.phase !== "synthesizing";
  return {
    id: researchPanelId(messageId, runId),
    title: "Deep research",
    subtitle: running ? "In progress" : `${webActivities.length} steps`,
    body: (
      <ResearchActivityBody
        progress={activity.progress}
        webActivities={webActivities}
        running={running}
      />
    ),
  };
}

/** Bubbles only open a snapshot; their mount/render lifecycle owns no panel data. */
export function useResearchPanel(
  messageId: string,
  activity: ResearchToolActivity,
  webActivities: WebToolActivity[],
) {
  const panel = useDetailPanel();
  return useCallback(() => {
    const request = researchPanelRequest(messageId, activity, webActivities);
    if (request) panel.open(request);
  }, [panel, messageId, activity, webActivities]);
}

/**
 * Mounted by ChatView beside virtualization. Its input is the final persisted +
 * stream display, not a second message cache. The rail can live outside ChatView.
 */
export function ResearchPanelOwner({ messages }: { messages: ReadonlyArray<DisplayMessage> }) {
  const panel = useDetailPanel();
  const selectedId = useDetailPanelSelectedId();
  const selectedMessage = selectedId?.startsWith("research:")
    ? messages.find((message) =>
        message.toolActivities.some((activity) => {
          if (activity.family !== "research") return false;
          const runId = runIdOf(activity);
          return !!runId && researchPanelId(message.id, runId) === selectedId;
        }),
      )
    : undefined;
  const messageId = selectedMessage?.id;
  const currentRunId = selectedMessage?.researchRunId;
  const activities = selectedMessage?.toolActivities;
  // Text smoothing changes display rows every token, but does not change their
  // activity data. Neither text nor the refreshed detail request is a dependency.
  const request = useMemo(() => {
    if (!messageId || !activities) return null;
    const activity = activities.find(
      (candidate): candidate is ResearchToolActivity =>
        candidate.family === "research" &&
        researchPanelId(messageId, runIdOf(candidate) ?? "") === selectedId,
    );
    if (!activity) return null;
    const runId = runIdOf(activity);
    // A retry can replace the durable run before its fresh stream data arrives.
    if (currentRunId !== undefined && currentRunId !== runId) return null;
    const webActivities = activities.filter(
      (candidate): candidate is WebToolActivity =>
        candidate.family === "web" && candidate.runId === runId,
    );
    return researchPanelRequest(messageId, activity, webActivities);
  }, [messageId, currentRunId, activities, selectedId]);

  useEffect(() => {
    if (!selectedId?.startsWith("research:")) return;
    if (request) panel.refresh(request);
    else panel.closeIfSelected(selectedId);
  }, [panel, selectedId, request]);
  return null;
}
