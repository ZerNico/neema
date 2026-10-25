import { Analytics01Icon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { startTransition, useState } from "react";
import { adminUsageQuery } from "~/modules/analytics/client/queries.ts";
import { DEFAULT_USAGE_RANGE, type UsageRangeEncoded } from "~/modules/analytics/schema.ts";
import {
  ChartCard,
  UsageOverview,
  UsageRangePicker,
  UsersTable,
} from "~/modules/analytics/ui/usage-dashboard.tsx";
import { EmptyState, Page } from "~/ui/page-shell.tsx";
import { m } from "~/paraglide/messages.js";

export function AnalyticsPage() {
  const [range, setRange] = useState<UsageRangeEncoded>(DEFAULT_USAGE_RANGE);
  const { data } = useSuspenseQuery(adminUsageQuery(range));
  const changeRange = (next: UsageRangeEncoded) => {
    // A new query key suspends while it loads. Marking this as a
    // transition keeps the current dashboard committed instead of
    // replacing the route with its empty Suspense fallback.
    startTransition(() => setRange(next));
  };

  return (
    <Page
      title={m.admin_analytics_title()}
      description={m.admin_analytics_description()}
      width="wide"
      actions={<UsageRangePicker range={range} onChange={changeRange} />}
    >
      {data.daily.length === 0 ? (
        // The range picker above stays live, so a quiet week can still switch
        // to 90 days and find history.
        <EmptyState
          icon={Analytics01Icon}
          title={m.admin_analytics_empty_title()}
          description={m.admin_analytics_empty_description()}
        />
      ) : (
        <>
          <UsageOverview
            summary={data.summary}
            daily={data.daily}
            byModel={data.byModel}
            previousSummary={data.previousSummary}
            window={data.window}
            showActiveUsers
          />
          <ChartCard title={m.admin_analytics_by_user()}>
            <UsersTable byUser={data.byUser} />
          </ChartCard>
        </>
      )}
    </Page>
  );
}
