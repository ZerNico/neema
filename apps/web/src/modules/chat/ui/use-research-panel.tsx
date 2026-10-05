import { GlobalSearchIcon } from "@hugeicons/core-free-icons";
import { useCallback } from "react";
import type { ResearchToolActivity } from "../client/use-message-stream.ts";
import { researchPanelId } from "./research-panel-id.ts";
import { ResearchActivityBody, type ResearchStepActivity } from "./research-panel.tsx";
import { type DetailPanelRequest } from "~/ui/detail-panel";
import { useDetailPanel } from "~/ui/detail-panel-context.ts";

export function researchPanelRequest(
  messageId: string,
  position: number,
  activity: ResearchToolActivity,
  webActivities: ResearchStepActivity[],
): DetailPanelRequest | null {
  if (position < 0) return null;
  const running = activity.status === "running";
  return {
    id: researchPanelId(messageId, position),
    title: activity.progress?.title ?? "Deep research",
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
