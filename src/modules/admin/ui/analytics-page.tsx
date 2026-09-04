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
      title="Analytics"
      description="Token usage, messages and cost across the instance. Every generation attempt counts — including retries and title runs."
      width="wide"
      actions={<UsageRangePicker range={range} onChange={changeRange} />}
    >
      {data.daily.length === 0 ? (
        // The range picker above stays live — a quiet week can still switch
        // to 90 days and find history.
        <EmptyState
          icon={Analytics01Icon}
          title="No usage in this range"
          description="Every generation attempt lands here once someone chats — tokens, messages and cost, including retries and title runs."
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
          <ChartCard title="By user">
            <UsersTable byUser={data.byUser} />
          </ChartCard>
        </>
      )}
    </Page>
  );
}
