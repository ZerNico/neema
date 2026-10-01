import {
  Alert02Icon,
  File01Icon,
  GlobalSearchIcon,
  Search01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useMemo } from "react";
import type {
  KnowledgeToolActivity,
  SkillToolActivity,
  ResearchToolActivity,
  WebToolActivity,
} from "../client/use-message-stream.ts";
import type { ResearchProgress, ResearchTaskProgress } from "../research-schema.ts";
import { Favicon, hostOf } from "./favicon.tsx";
import type { DisplayMessage } from "./message-list.tsx";
import {
  useDetailPanel,
  useDetailPanelTabContent,
  useDetailPanelTabIds,
  type DetailPanelRequest,
} from "~/ui/detail-panel";
import { Spinner } from "~/ui/primitives/spinner";
import { cn } from "~/ui/utils";
import { MotionSwap } from "~/ui/motion.tsx";

// The transcript row stays one line; this is where the rest lives: what the
// run did, in order, grouped by task. The sources panel is a separate view
// (citation chips, the message menu); the plan is the model's working note
// and stays internal.

const taskLabels: Record<ResearchTaskProgress["status"], string> = {
  queued: "Queued",
  running: "Investigating",
  complete: "Done",
  error: "Incomplete",
  aborted: "Stopped",
};

// Limitations are written for the model that synthesises the answer, not the
// reader: "InvalidOutputError", output limits and usage mean nothing to them.
// Provider hiccups are routine, and the answer covers thin spots, so the
// panel shows a plain sentence only when coverage actually fell short.
const coverageNote = (progress: ResearchProgress | undefined): string | null => {
  const limitations = progress?.limitations ?? [];
  if (progress?.phase === "aborted") return null;
  if (limitations.some((limitation) => /search was unavailable/i.test(limitation)))
    return "Web search wasn’t working, so most of the research couldn’t happen.";
  if (limitations.some((limitation) => /No usable research reports/i.test(limitation)))
    return "The research didn’t turn up anything usable.";
  const incomplete = (progress?.tasks ?? []).filter((task) => task.status === "error").length;
  if (incomplete > 0)
    return incomplete === 1
      ? "One topic couldn’t be finished, so some of this may be missing."
      : `${incomplete} topics couldn’t be finished, so some of this may be missing.`;
  if (limitations.some((limitation) => /time limit|cut short|abridged/i.test(limitation)))
    return "The research ran out of room, so some of this may be missing.";
  return null;
};

interface ActivityItem {
  key: string;
  label: string;
  url?: string;
}

/** Web and knowledge steps, grouped by task like the runner groups them. */
export type ResearchStepActivity = WebToolActivity | KnowledgeToolActivity | SkillToolActivity;

const describe = (activity: ResearchStepActivity): { verb: string; items: ActivityItem[] } => {
  if (activity.family === "skill")
    return {
      verb:
        activity.status === "running"
          ? "Using skill guidance"
          : activity.status === "error"
            ? "Skill guidance unavailable"
            : "Used skill guidance",
      items: [
        {
          key: activity.callId,
          label: `${activity.skillName}${activity.path && activity.path !== "SKILL.md" ? ` · ${activity.path}` : ""}`,
        },
      ],
    };
  if (activity.family === "knowledge") {
    const running = activity.status === "running";
    const count = activity.summary?.passagesReturned ?? 0;
    const documents = activity.summary?.documentsListed ?? 0;
    // Targets are opaque version ids: name what happened, not the handle.
    return activity.name === "list_documents"
      ? {
          verb: running ? "Listing documents" : "Listed documents",
          items: running ? [] : [{ key: "count", label: `${documents} documents` }],
        }
      : activity.name === "search_knowledge"
        ? {
            verb: running ? "Searching knowledge" : "Searched knowledge",
            items: [
              ...(activity.summary?.targets ?? []).map((query) => ({
                key: query,
                label: `“${query}”`,
              })),
              ...(running ? [] : [{ key: "count", label: `${count} excerpts` }]),
            ],
          }
        : {
            verb: running ? "Reading documents" : "Read documents",
            items: running ? [] : [{ key: "count", label: `${count} excerpts` }],
          };
  }
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

function ActivityRow({ activity }: { activity: ResearchStepActivity }) {
  const { verb, items } = describe(activity);
  const failed = activity.status === "error";
  const resultCount = activity.family === "web" ? activity.resultCount : undefined;
  return (
    <li className="flex min-w-0 gap-2 py-1 text-xs leading-relaxed">
      {/* h-lh: exactly one line of the text beside it, so the icon centres on
          the first line whatever the font metrics. */}
      <span className="flex h-lh shrink-0 items-center">
        <MotionSwap value={activity.status} kind="icon" className="size-3.5">
          {activity.status === "running" ? (
            <Spinner aria-hidden className="text-muted-foreground size-3.5" />
          ) : failed ? (
            <HugeiconsIcon
              icon={Alert02Icon}
              strokeWidth={2}
              className="text-warning size-3.5"
              aria-hidden
            />
          ) : activity.family === "knowledge" || activity.family === "skill" ? (
            <HugeiconsIcon
              icon={File01Icon}
              strokeWidth={2}
              className="text-muted-foreground size-3.5"
              aria-hidden
            />
          ) : activity.name === "read_url" ? (
            <HugeiconsIcon
              icon={Tick02Icon}
              strokeWidth={2}
              className="text-success size-3.5"
              aria-hidden
            />
          ) : (
            <HugeiconsIcon
              icon={Search01Icon}
              strokeWidth={2}
              className="text-muted-foreground size-3.5"
              aria-hidden
            />
          )}
        </MotionSwap>
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
                <Favicon url={item.url} className="mr-1 inline-block size-3 align-[-2px]" />
                {item.label}
              </a>
            ) : (
              <span className="text-foreground">{item.label}</span>
            )}
          </span>
        ))}
        {resultCount !== undefined && activity.name !== "read_url" && !failed ? (
          <span className="text-muted-foreground/70"> · {resultCount} results</span>
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
  activities: ResearchStepActivity[];
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
            <MotionSwap value={task.status}>{taskLabels[task.status]}</MotionSwap>
          </span>
        </header>
      ) : null}
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
  webActivities: ResearchStepActivity[];
  running: boolean;
}) {
  // Ordinal is dispatch order, which is what a reader expects to scroll through.
  // oxlint-disable-next-line no-array-sort -- fresh array
  const tasks = [...(progress?.tasks ?? [])].sort((a, b) => a.ordinal - b.ordinal);
  const byTask = new Map<string, ResearchStepActivity[]>();
  const unassigned: ResearchStepActivity[] = [];
  for (const activity of webActivities) {
    const list = activity.taskId ? byTask.get(activity.taskId) : undefined;
    if (activity.taskId && tasks.some((task) => task.id === activity.taskId)) {
      if (list) list.push(activity);
      else byTask.set(activity.taskId, [activity]);
    } else unassigned.push(activity);
  }
  const note = coverageNote(progress);
  const empty = tasks.length === 0 && unassigned.length === 0;

  return (
    <div className="flex flex-col gap-5">
      {empty ? (
        <p className="text-muted-foreground text-xs">
          {running ? "Planning what to look into…" : "Nothing was researched."}
        </p>
      ) : null}
      {tasks.map((task) => (
        <TaskGroup key={task.id} task={task} activities={byTask.get(task.id) ?? []} />
      ))}
      {unassigned.length > 0 ? <TaskGroup task={null} activities={unassigned} /> : null}
      {note && !running ? <p className="text-muted-foreground text-xs">{note}</p> : null}
    </div>
  );
}

const researchPanelId = (messageId: string, runId: string) =>
  `research:${JSON.stringify([messageId, runId])}`;

const runIdOf = (activity: ResearchToolActivity) => activity.progress?.runId ?? activity.runId;

function researchPanelRequest(
  messageId: string,
  activity: ResearchToolActivity,
  webActivities: ResearchStepActivity[],
): DetailPanelRequest | null {
  const runId = runIdOf(activity);
  if (!runId) return null;
  const running = activity.status === "running";
  return {
    id: researchPanelId(messageId, runId),
    title: "Deep research",
    subtitle: running ? "In progress" : `${webActivities.length} steps`,
    icon: GlobalSearchIcon,
    restorable: true,
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
  webActivities: ResearchStepActivity[],
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
 * Every research tab is kept current, open or not, so a restored one comes back.
 */
export function ResearchPanelOwner({ messages }: { messages: ReadonlyArray<DisplayMessage> }) {
  const tabIds = useDetailPanelTabIds();
  return tabIds
    .filter((id) => id.startsWith("research:"))
    .map((id) => <ResearchTabOwner key={id} id={id} messages={messages} />);
}

function ResearchTabOwner({
  id,
  messages,
}: {
  id: string;
  messages: ReadonlyArray<DisplayMessage>;
}) {
  const message = messages.find((candidate) =>
    candidate.toolActivities.some(
      (activity) =>
        activity.family === "research" &&
        researchPanelId(candidate.id, runIdOf(activity) ?? "") === id,
    ),
  );
  const messageId = message?.id;
  const activities = message?.toolActivities;
  // Text smoothing changes display rows every token, but does not change their
  // activity data. Neither text nor the refreshed detail request is a dependency.
  const request = useMemo(() => {
    if (!messageId || !activities) return null;
    const activity = activities.find(
      (candidate): candidate is ResearchToolActivity =>
        candidate.family === "research" &&
        researchPanelId(messageId, runIdOf(candidate) ?? "") === id,
    );
    if (!activity) return null;
    const runId = runIdOf(activity);
    const webActivities = activities.filter(
      (candidate): candidate is ResearchStepActivity =>
        (candidate.family === "web" ||
          candidate.family === "knowledge" ||
          candidate.family === "skill") &&
        candidate.runId === runId,
    );
    return researchPanelRequest(messageId, activity, webActivities);
  }, [messageId, activities, id]);

  useDetailPanelTabContent(id, request);
  return null;
}
