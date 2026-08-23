import { createFileRoute } from "@tanstack/react-router";
import { AnalyticsPage } from "~/modules/admin/ui/analytics-page.tsx";
import { adminUsageQuery } from "~/modules/analytics/client/queries.ts";
import { DEFAULT_USAGE_RANGE } from "~/modules/analytics/schema.ts";

export const Route = createFileRoute("/_app/admin/analytics")({
  loader: async ({ context }) => {
    // The page's default range; other ranges load on demand.
    await context.queryClient.ensureQueryData(adminUsageQuery(DEFAULT_USAGE_RANGE));
  },
  component: AnalyticsPage,
});
