import { createFileRoute } from "@tanstack/react-router";
import { chatModelsQuery } from "~/modules/chat/client/queries.ts";
import { knowledgeCollectionsQuery } from "~/modules/knowledge/client/queries.ts";
import { ScheduleCreatePage } from "~/modules/schedules/ui/schedule-create-page.tsx";
import { skillsQuery } from "~/modules/skills/client/queries.ts";

export const Route = createFileRoute("/_app/schedules/new")({
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(chatModelsQuery),
      context.queryClient.prefetchQuery(knowledgeCollectionsQuery),
      context.queryClient.prefetchQuery(skillsQuery),
    ]);
  },
  component: ScheduleCreatePage,
});
