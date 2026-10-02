import type { ResearchStepActivity } from "./research-panel.tsx";
import { hostOf } from "./favicon.tsx";

/** The newest running target, else the newest target seen: what it is on now. */
export const currentDetail = (
  webActivities: ReadonlyArray<ResearchStepActivity>,
): string | null => {
  let latest: ResearchStepActivity | undefined;
  for (const activity of webActivities) {
    if (activity.status === "running") latest = activity;
    else if (!latest || latest.status !== "running") latest = activity;
  }
  if (!latest) return null;
  if (latest.family === "skill") return `Using ${latest.skillName} guidance`;
  if (latest.family === "knowledge")
    return latest.name === "list_knowledge_documents"
      ? "Listing documents"
      : latest.name === "search_knowledge"
        ? "Searching knowledge"
        : "Reading documents";
  const target = latest.targets.at(-1)?.trim();
  if (!target) return null;
  return latest.name === "read_url" ? `Reading ${hostOf(target)}` : `Searching “${target}”`;
};

/** Distinct pages a run's steps gathered, newest site first, for the count and the icons. */
export const gatheredPages = (webActivities: ReadonlyArray<ResearchStepActivity>) => {
  const pages = new Map<string, string>();
  for (const activity of webActivities)
    if (activity.family === "web")
      for (const source of activity.sources ?? [])
        if (source.kind !== "document") pages.set(source.url, hostOf(source.url));
  return pages;
};
