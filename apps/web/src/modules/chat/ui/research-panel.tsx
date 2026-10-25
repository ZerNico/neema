import { m } from "~/paraglide/messages.js";
import {
  Alert02Icon,
  Book02Icon,
  FolderLibraryIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { m as motion } from "motion/react";
import { useState, type ReactNode } from "react";
import type {
  KnowledgeToolActivity,
  SkillToolActivity,
  WebToolActivity,
} from "../client/use-message-stream.ts";
import type { ResearchProgress, ResearchTaskProgress } from "../research-schema.ts";
import { ActivityChevron, ActivityFace, ActivityNote, ActivityQueries } from "./activity-face.tsx";
import { Favicon } from "./favicon.tsx";
import { hostOf } from "./host-of.ts";
import { FaviconStack } from "./tool-activity-block.tsx";
import { cn } from "~/ui/utils";
import { Disclosure, DisclosureContent, DisclosureTrigger } from "~/ui/disclosure.tsx";
import { focusRingClassName } from "~/ui/focus-ring.ts";
import { MotionSwap } from "~/ui/motion.tsx";
import { currentDetail, gatheredPages } from "./research-steps.ts";

// The story behind the transcript card: the plan, each topic as work on it
// starts, and where the sources came from. Briefs and reports stay internal.

// Limitations are written for the model that synthesises the answer, not the
// reader: "InvalidOutputError", output limits and usage mean nothing to them.
// Provider hiccups are routine, and the answer covers thin spots, so the
// panel shows a plain sentence only when coverage actually fell short.
const coverageNote = (progress: ResearchProgress | undefined): string | null => {
  const limitations = progress?.limitations ?? [];
  if (progress?.phase === "aborted") return null;
  if (limitations.some((limitation) => /search was unavailable/i.test(limitation)))
    return m.chat_research_note_no_search();
  if (limitations.some((limitation) => /No usable research reports/i.test(limitation)))
    return m.chat_research_note_nothing();
  const incomplete = (progress?.tasks ?? []).filter((task) => task.status === "error").length;
  if (incomplete > 0) return m.chat_research_note_incomplete({ count: incomplete });
  if (limitations.some((limitation) => /time limit|cut short|abridged/i.test(limitation)))
    return m.chat_research_note_out_of_room();
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
          label={
            running
              ? m.chat_research_step_using_skill({ name: activity.skillName })
              : m.chat_research_step_used_skill({ name: activity.skillName })
          }
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
                  ? m.chat_research_listing()
                  : m.chat_research_step_listed({
                      count: activity.summary?.documentsListed ?? 0,
                    })
                : searching
                  ? running
                    ? m.chat_research_step_searching_documents()
                    : m.chat_research_step_searched_documents()
                  : running
                    ? m.chat_research_reading_documents()
                    : m.chat_research_step_read_documents()
            }
            detail={!running && !listing ? m.chat_research_step_excerpts({ count }) : null}
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
            label={(running
              ? m.chat_research_step_reading_pages
              : status === "failed"
                ? m.chat_research_step_read_failed
                : m.chat_research_step_read_pages)({ count: targets.length })}
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
              ? m.chat_research_step_searching_web()
              : status === "failed"
                ? m.chat_research_step_search_failed()
                : m.chat_research_step_searched_web()
          }
          detail={
            activity.resultCount !== undefined && !running && status !== "failed"
              ? m.chat_research_step_results({ count: activity.resultCount })
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

type MilestoneState = "live" | "done" | "failed";

/**
 * One step of the run's story: a dot on the rail, what happened, and one line
 * of detail. What it involved opens underneath on click, so the panel reads as
 * milestones first and the full log only where someone asks for it.
 */
function Milestone({
  title,
  finding,
  detail,
  state,
  last,
  children,
}: {
  title: string;
  /** What a finished topic established, in a sentence; quieter than the answer. */
  finding?: string | undefined;
  detail?: string | null | undefined;
  state: MilestoneState;
  last: boolean;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const live = state === "live";
  const face = (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span
        className={cn("text-foreground text-sm [overflow-wrap:anywhere]", live && "text-shimmer")}
      >
        {title}
      </span>
      {finding ? (
        <motion.span
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.3, ease: "easeOut" }}
          className="text-muted-foreground text-[13px] leading-snug [overflow-wrap:anywhere]"
        >
          {finding}
        </motion.span>
      ) : null}
      {detail ? (
        <span className="text-muted-foreground flex min-w-0 text-xs">
          <MotionSwap value={detail} kind="rolling-text" className="min-w-0">
            {detail}
          </MotionSwap>
        </span>
      ) : null}
    </span>
  );
  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      className="relative flex gap-3 pb-5 last:pb-0"
    >
      {last ? null : (
        <span className="bg-border absolute top-5 bottom-0 left-[5px] w-px" aria-hidden />
      )}
      <span className="flex h-5 w-[11px] shrink-0 items-center justify-center" aria-hidden>
        <MotionSwap value={state} kind="icon">
          {state === "failed" ? (
            <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} className="text-warning size-3.5" />
          ) : (
            <span
              className={cn(
                "block size-[11px] rounded-full border-2",
                live
                  ? "border-foreground bg-background"
                  : "border-transparent bg-muted-foreground/50",
              )}
            />
          )}
        </MotionSwap>
      </span>
      {children ? (
        <Disclosure open={open} onOpenChange={setOpen} className="flex min-w-0 flex-1 flex-col">
          <DisclosureTrigger
            className={cn(focusRingClassName, "group flex w-full min-w-0 text-left")}
          >
            <span className="flex min-w-0 flex-1 items-start gap-2">
              {face}
              <span className="text-muted-foreground group-hover:text-foreground flex h-5 items-center">
                <ActivityChevron open={open} />
              </span>
            </span>
          </DisclosureTrigger>
          <DisclosureContent>
            <div className="pt-2.5">{children}</div>
          </DisclosureContent>
        </Disclosure>
      ) : (
        face
      )}
    </motion.li>
  );
}

function StepList({ activities }: { activities: ResearchStepActivity[] }) {
  return (
    <ol className="flex flex-col gap-2.5">
      {activities.map((activity) => (
        <StepRow key={activity.callId} activity={activity} />
      ))}
    </ol>
  );
}

/** The run's sources by site, as a reader sizes up what it drew on. */
function SourcesBySite({ activities }: { activities: ResearchStepActivity[] }) {
  const bySite = new Map<string, { url: string; count: number }>();
  for (const [url, site] of gatheredPages(activities)) {
    const entry = bySite.get(site) ?? { url, count: 0 };
    entry.count++;
    bySite.set(site, entry);
  }
  const sites = [...bySite.entries()]
    .map(([site, entry]) => ({ site, ...entry }))
    .toSorted((a, b) => b.count - a.count);
  const top = sites.slice(0, 5);
  const most = top[0]?.count ?? 1;
  const rest = sites.slice(5).reduce((sum, site) => sum + site.count, 0);
  return (
    <ul className="flex flex-col gap-1.5" aria-label={m.chat_research_sources_by_site()}>
      {top.map((site) => (
        <li key={site.site} className="flex min-w-0 items-center gap-2 text-xs">
          <Favicon url={site.url} className="size-3.5" />
          <span className="min-w-0 flex-1 truncate">{site.site}</span>
          <span className="text-muted-foreground shrink-0 tabular-nums">
            {m.chat_research_sources({ count: site.count })}
          </span>
          <span className="bg-muted h-1 w-16 shrink-0 overflow-hidden rounded-full" aria-hidden>
            <span
              className="bg-muted-foreground/50 block h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none"
              style={{ width: `${Math.max(8, (site.count / most) * 100)}%` }}
            />
          </span>
        </li>
      ))}
      {rest > 0 ? (
        <li className="text-muted-foreground text-xs">
          {m.chat_research_more_sources({ count: rest })}
        </li>
      ) : null}
    </ul>
  );
}

const taskMilestone = (
  task: ResearchTaskProgress,
  activities: ResearchStepActivity[],
): { detail: string | null; state: MilestoneState } => {
  const pages = gatheredPages(activities).size;
  switch (task.status) {
    case "running":
      return {
        detail: currentDetail(activities) ?? m.chat_research_getting_started(),
        state: "live",
      };
    case "error":
      return { detail: m.chat_research_task_failed(), state: "failed" };
    case "aborted":
      return { detail: m.chat_research_task_stopped(), state: "done" };
    default:
      return {
        detail: pages
          ? m.chat_research_sources({ count: pages })
          : activities.length
            ? m.chat_research_steps({ count: activities.length })
            : null,
        state: "done",
      };
  }
};

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
  const tasks = (progress?.tasks ?? []).toSorted((a, b) => a.ordinal - b.ordinal);
  const byTask = new Map<string, ResearchStepActivity[]>();
  const unassigned: ResearchStepActivity[] = [];
  for (const activity of webActivities) {
    if (activity.taskId && tasks.some((task) => task.id === activity.taskId))
      byTask.set(activity.taskId, [...(byTask.get(activity.taskId) ?? []), activity]);
    else unassigned.push(activity);
  }
  const note = coverageNote(progress);
  const total = gatheredPages(webActivities).size;

  const milestones: Array<{
    key: string;
    title: string;
    finding?: string;
    detail?: string | null;
    state: MilestoneState;
    body?: ReactNode;
  }> = [];
  if (tasks.length)
    milestones.push({
      key: "plan",
      title: m.chat_research_made_plan(),
      detail: m.chat_research_topics({ count: tasks.length }),
      state: "done",
      body: (
        <ol className="text-muted-foreground flex list-decimal flex-col gap-1 pl-4 text-xs">
          {tasks.map((task) => (
            <li key={task.id} className="[overflow-wrap:anywhere]">
              {task.title}
            </li>
          ))}
        </ol>
      ),
    });
  else if (running)
    milestones.push({ key: "plan", title: m.chat_research_planning(), state: "live" });
  // A topic joins the story when work on it starts; until then it sits in the plan.
  for (const task of tasks) {
    if (task.status === "queued") continue;
    const activities = byTask.get(task.id) ?? [];
    milestones.push({
      key: task.id,
      title: task.title,
      ...(task.status === "complete" && task.finding ? { finding: task.finding } : {}),
      ...taskMilestone(task, activities),
      ...(activities.length ? { body: <StepList activities={activities} /> } : {}),
    });
  }
  if (unassigned.length)
    milestones.push({
      key: "other",
      title: m.chat_research_other_steps(),
      detail: m.chat_research_steps({ count: unassigned.length }),
      state: unassigned.some((activity) => activity.status === "running") ? "live" : "done",
      body: <StepList activities={unassigned} />,
    });
  if (total)
    milestones.push({
      key: "sources",
      title: m.chat_research_sources({ count: total }),
      detail: running ? m.chat_research_counting() : null,
      state: "done",
      body: <SourcesBySite activities={webActivities} />,
    });

  return (
    <div className="flex flex-col gap-5">
      {milestones.length ? (
        <ol className="flex flex-col">
          {milestones.map(({ key, body, ...milestone }, index) => (
            <Milestone key={key} {...milestone} last={index === milestones.length - 1}>
              {body}
            </Milestone>
          ))}
        </ol>
      ) : (
        <p className="text-muted-foreground text-xs">{m.chat_research_nothing()}</p>
      )}
      {note && !running ? <ActivityNote>{note}</ActivityNote> : null}
    </div>
  );
}
