import { createFileRoute } from "@tanstack/react-router";
import { myUsageQuery } from "~/modules/analytics/client/queries.ts";
import { DEFAULT_USAGE_RANGE } from "~/modules/analytics/schema.ts";
import { UsagePage } from "~/modules/settings/ui/usage-page.tsx";

export const Route = createFileRoute("/_app/settings/usage")({
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(myUsageQuery(DEFAULT_USAGE_RANGE));
  },
  component: UsagePage,
});
