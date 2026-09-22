import { createFileRoute } from "@tanstack/react-router";
import { chatModelsQuery } from "~/modules/chat/client/queries.ts";
import { knowledgeCollectionsQuery } from "~/modules/knowledge/client/queries.ts";
import { scheduleQuery, scheduleRunsQuery } from "~/modules/schedules/client/queries.ts";
import { ScheduleDetailPage } from "~/modules/schedules/ui/schedule-detail-page.tsx";
import { skillsQuery } from "~/modules/skills/client/queries.ts";

export const Route = createFileRoute("/_app/schedules/$scheduleId")({
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(chatModelsQuery),
      context.queryClient.prefetchQuery(knowledgeCollectionsQuery),
      context.queryClient.prefetchQuery(skillsQuery),
      // Prefetch, not ensure: access loss renders the page's own error state.
      context.queryClient.prefetchQuery({ ...scheduleQuery(params.scheduleId), retry: false }),
      context.queryClient.prefetchQuery(scheduleRunsQuery(params.scheduleId)),
    ]);
  },
  component: ScheduleRoute,
});

function ScheduleRoute() {
  const { scheduleId } = Route.useParams();
  return <ScheduleDetailPage scheduleId={scheduleId} />;
}
