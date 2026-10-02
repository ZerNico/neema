import {
  Alert02Icon,
  Book02Icon,
  FolderLibraryIcon,
  GlobalSearchIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useMemo, useState } from "react";
import type {
  KnowledgeToolActivity,
  SkillToolActivity,
  ResearchToolActivity,
  ToolActivity,
  WebToolActivity,
} from "../client/use-message-stream.ts";
import type { ResearchProgress, ResearchTaskProgress } from "../research-schema.ts";
import { ActivityFace, ActivityNote, ActivityQueries } from "./activity-face.tsx";
import { Favicon, hostOf } from "./favicon.tsx";
import { FaviconStack } from "./tool-activity-block.tsx";
import type { DisplayMessage } from "./message-list.tsx";
import { researchPanelId, researchPosition } from "./research-panel-id.ts";
import {
  useDetailPanel,
  useDetailPanelTabContent,
  useDetailPanelTabIds,
  type DetailPanelRequest,
} from "~/ui/detail-panel";
import { cn } from "~/ui/utils";
import { MotionSwap } from "~/ui/motion.tsx";

// The transcript row stays one line; this is where the rest lives: what the
// run did, in order, grouped by task. The sources panel is a separate view
// (citation chips, the message menu); the plan is the model's working note
// and stays internal.

const taskLabels: Record<ResearchTaskProgress["status"], string> = {
  queued: "Up next",
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

/** Web and knowledge steps, grouped by task like the runner groups them. */
export type ResearchStepActivity = WebToolActivity | KnowledgeToolActivity | SkillToolActivity;

const stepStatus = (activity: ResearchStepActivity) =>
  activity.status === "running" ? "running" : activity.status === "error" ? "failed" : "done";

/** One step, drawn like every other tool row: icon, label, detail, then what it touched. */
function StepRow({ activity }: { activity: ResearchStepActivity }) {
  const running = activity.status === "running";
  const status = stepStatus(activity);
  if (activity.family === "skill")
    return (
      <li className={stepClassName}>
        <ActivityFace
          icon={Book02Icon}
          label={running ? `Using ${activity.skillName}` : `Used ${activity.skillName}`}
          status={status}
        />
      </li>
    );
  if (activity.family === "knowledge") {
    const count = activity.summary?.passagesReturned ?? 0;
    const listing = activity.name === "list_knowledge_documents";
    const searching = activity.name === "search_knowledge";
    return (
      <li className="flex min-w-0 flex-col gap-1.5">
        <div className={stepClassName}>
          <ActivityFace
            icon={FolderLibraryIcon}
            label={
              listing
                ? running
                  ? "Listing documents"
                  : `Listed ${activity.summary?.documentsListed ?? 0} documents`
                : searching
                  ? running
                    ? "Searching documents"
                    : "Searched documents"
                  : running
                    ? "Reading documents"
                    : "Read documents"
            }
            detail={
              !running && !listing ? `${count} ${count === 1 ? "excerpt" : "excerpts"}` : null
            }
            status={status}
          />
        </div>
        {searching ? <QueryChips queries={activity.summary?.targets ?? []} /> : null}
      </li>
    );
  }
  const targets = activity.targets.map((target) => target.trim()).filter(Boolean);
  if (activity.name === "read_url")
    return (
      <li className="flex min-w-0 flex-col gap-1">
        <div className={stepClassName}>
          <ActivityFace
            glyph={<FaviconStack urls={targets.slice(0, 4)} />}
            label={`${running ? "Reading" : status === "failed" ? "Couldn’t read" : "Read"} ${
              targets.length === 1 ? "a page" : `${targets.length} pages`
            }`}
            status={status}
          />
        </div>
        {targets.length > 0 ? (
          <p className="text-muted-foreground pl-6 text-xs [overflow-wrap:anywhere]">
            {targets.map((url, index) => (
              <span key={url}>
                {index > 0 ? ", " : null}
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="hover:text-foreground transition-colors"
                >
                  {hostOf(url)}
                </a>
              </span>
            ))}
          </p>
        ) : null}
      </li>
    );
  return (
    <li className="flex min-w-0 flex-col gap-1.5">
      <div className={stepClassName}>
        <ActivityFace
          icon={Search01Icon}
          label={
            running
              ? "Searching the web"
              : status === "failed"
                ? "Couldn’t search"
                : "Searched the web"
          }
          detail={
            activity.resultCount !== undefined && !running && status !== "failed"
              ? `${activity.resultCount} results`
              : null
          }
          status={status}
        />
      </div>
      <QueryChips queries={targets} />
    </li>
  );
}

const stepClassName = "text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs";

function QueryChips({ queries }: { queries: ReadonlyArray<string> }) {
  if (!queries.length) return null;
  return (
    <div className="pl-6">
      <ActivityQueries queries={queries} limit={3} />
    </div>
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
    <section className="flex min-w-0 flex-col gap-2.5">
      {task ? (
        <header className="flex items-baseline gap-2">
          <h3 className="min-w-0 flex-1 text-sm font-medium [overflow-wrap:anywhere]">
            {task.title}
          </h3>
          <span className="text-muted-foreground flex shrink-0 items-center gap-1 text-xs">
            {task.status === "error" ? (
              <HugeiconsIcon
                icon={Alert02Icon}
                strokeWidth={2}
                className="text-warning size-3.5"
                aria-hidden
              />
            ) : null}
            <MotionSwap value={task.status}>
              <span className={cn(task.status === "running" && "text-shimmer")}>
                {taskLabels[task.status]}
              </span>
            </MotionSwap>
          </span>
        </header>
      ) : null}
      {activities.length > 0 ? (
        <ol className="flex flex-col gap-2.5">
          {activities.map((activity) => (
            <StepRow key={activity.callId} activity={activity} />
          ))}
        </ol>
      ) : task?.status === "queued" || task?.status === "running" ? (
        <p className="text-muted-foreground text-xs">Nothing yet.</p>
      ) : null}
    </section>
  );
}

/** The run's sources by site, as a reader sizes up what it drew on. */
function SourceOverview({
  activities,
  running,
}: {
  activities: ResearchStepActivity[];
  running: boolean;
}) {
  const bySite = new Map<string, { url: string; urls: Set<string> }>();
  for (const activity of activities) {
    if (activity.family !== "web") continue;
    for (const source of activity.sources ?? []) {
      if (source.kind === "document") continue;
      const site = hostOf(source.url);
      const entry = bySite.get(site) ?? { url: source.url, urls: new Set<string>() };
      entry.urls.add(source.url);
      bySite.set(site, entry);
    }
  }
  const sites = [...bySite.entries()]
    .map(([site, entry]) => ({ site, url: entry.url, count: entry.urls.size }))
    .toSorted((a, b) => b.count - a.count);
  const total = sites.reduce((sum, site) => sum + site.count, 0);
  if (!total) return null;
  const top = sites.slice(0, 4);
  const most = top[0]!.count;
  const rest = total - top.reduce((sum, site) => sum + site.count, 0);
  return (
    <section className="flex flex-col gap-3">
      <div className="text-muted-foreground flex items-center gap-1.5 text-sm">
        <ActivityFace
          glyph={<FaviconStack urls={top.map((site) => site.url)} />}
          label={`${total} ${total === 1 ? "source" : "sources"}${running ? " so far" : ""}`}
          status={running ? "running" : "done"}
        />
      </div>
      <ul className="flex flex-col gap-1.5" aria-label="Sources by site">
        {top.map((site) => (
          <li key={site.site} className="flex min-w-0 items-center gap-2 text-xs">
            <Favicon url={site.url} className="size-3.5" />
            <span className="min-w-0 flex-1 truncate">{site.site}</span>
            <span className="text-muted-foreground shrink-0 tabular-nums">
              {site.count} {site.count === 1 ? "source" : "sources"}
            </span>
            <span className="bg-muted h-1 w-16 shrink-0 overflow-hidden rounded-full" aria-hidden>
              <span
                className="bg-muted-foreground/50 block h-full rounded-full"
                style={{ width: `${Math.max(8, (site.count / most) * 100)}%` }}
              />
            </span>
          </li>
        ))}
        {rest > 0 ? (
          <li className="text-muted-foreground text-xs">
            {rest} more {rest === 1 ? "source" : "sources"}
          </li>
        ) : null}
      </ul>
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
    <div className="flex flex-col gap-6">
      <SourceOverview activities={webActivities} running={running} />
      {empty ? (
        <p className="text-muted-foreground text-xs">
          {running ? (
            <span className="text-shimmer">Planning what to look into</span>
          ) : (
            "Nothing was researched."
          )}
        </p>
      ) : null}
      {tasks.map((task) => (
        <TaskGroup key={task.id} task={task} activities={byTask.get(task.id) ?? []} />
      ))}
      {unassigned.length > 0 ? <TaskGroup task={null} activities={unassigned} /> : null}
      {note && !running ? <ActivityNote>{note}</ActivityNote> : null}
    </div>
  );
}

const runIdOf = (activity: ResearchToolActivity) => activity.progress?.runId ?? activity.runId;

function researchPanelRequest(
  messageId: string,
  position: number,
  activity: ResearchToolActivity,
  webActivities: ResearchStepActivity[],
): DetailPanelRequest | null {
  if (position < 0) return null;
  const running = activity.status === "running";
  return {
    id: researchPanelId(messageId, position),
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
  position: number,
  activity: ResearchToolActivity,
  webActivities: ResearchStepActivity[],
) {
  const panel = useDetailPanel();
  return useCallback(() => {
    const request = researchPanelRequest(messageId, position, activity, webActivities);
    if (request) panel.open(request);
  }, [panel, messageId, position, activity, webActivities]);
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
  const atPosition = (candidate: DisplayMessage, activity: ToolActivity) =>
    activity.family === "research" &&
    researchPanelId(candidate.id, researchPosition(candidate.toolActivities, activity.callId)) ===
      id;
  const message = messages.find((candidate) =>
    candidate.toolActivities.some((activity) => atPosition(candidate, activity)),
  );
  const current = message?.toolActivities.find((candidate): candidate is ResearchToolActivity =>
    atPosition(message, candidate),
  );
  // A tab opened on a starting run binds to the run that replaces it. A retry
  // puts a different run, or a new placeholder, at the same position: the run
  // this tab showed is gone, so it closes.
  const [boundRun, setBoundRun] = useState<string | null>(null);
  const currentRun = current ? (runIdOf(current) ?? null) : null;
  if (currentRun && boundRun === null) setBoundRun(currentRun);
  const replaced = boundRun !== null && currentRun !== boundRun;
  // Text smoothing changes display rows every token, but does not change their
  // activity data. Neither text nor the refreshed detail request is a dependency.
  const request = useMemo(() => {
    const activity = current;
    if (!message || !activity || replaced) return null;
    const runId = runIdOf(activity);
    const webActivities = message.toolActivities.filter(
      (candidate): candidate is ResearchStepActivity =>
        (candidate.family === "web" ||
          candidate.family === "knowledge" ||
          candidate.family === "skill") &&
        !!runId &&
        candidate.runId === runId,
    );
    return researchPanelRequest(
      message.id,
      researchPosition(message.toolActivities, activity.callId),
      activity,
      webActivities,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the message's activities, not its text
  }, [message?.id, message?.toolActivities, id, replaced]);

  useDetailPanelTabContent(id, request);
  return null;
}
