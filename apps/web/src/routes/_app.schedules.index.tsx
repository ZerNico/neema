import { createFileRoute } from "@tanstack/react-router";
import { schedulesQuery } from "~/modules/schedules/client/queries.ts";
import { SchedulesPage } from "~/modules/schedules/ui/schedules-page.tsx";

export const Route = createFileRoute("/_app/schedules/")({
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(schedulesQuery);
  },
  component: SchedulesPage,
});
