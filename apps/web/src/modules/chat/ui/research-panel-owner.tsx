import { useMemo, useState } from "react";
import type { ResearchToolActivity, ToolActivity } from "../client/use-message-stream.ts";
import type { DisplayMessage } from "./message-list.tsx";
import { researchPanelId, researchPosition } from "./research-panel-id.ts";
import type { ResearchStepActivity } from "./research-panel.tsx";
import { researchPanelRequest } from "./use-research-panel.tsx";
import { useDetailPanelTabContent, useDetailPanelTabIds } from "~/ui/detail-panel-context.ts";

const runIdOf = (activity: ResearchToolActivity) => activity.progress?.runId ?? activity.runId;

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
