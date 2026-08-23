import { Analytics01Icon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { AdminPage, EmptyState } from "./admin-shell.tsx";
import { adminUsageQuery } from "~/modules/analytics/client/queries.ts";
import type { UsageRangeDays } from "~/modules/analytics/schema.ts";
import {
  ChartCard,
  UsageOverview,
  UsageRangeSelect,
  UsersTable,
} from "~/modules/analytics/ui/usage-dashboard.tsx";

export function AnalyticsPage() {
  const [days, setDays] = useState<UsageRangeDays>(30);
  const { data } = useSuspenseQuery(adminUsageQuery(days));

  return (
    <AdminPage
      title="Analytics"
      description="Token usage, messages and cost across the instance. Every generation attempt counts — including retries and title runs."
      actions={<UsageRangeSelect days={days} onChange={setDays} />}
    >
      {data.daily.length === 0 ? (
        // The range select above stays live — a quiet week can still switch
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
            days={days}
            showActiveUsers
          />
          <ChartCard title="By user">
            <UsersTable byUser={data.byUser} />
          </ChartCard>
        </>
      )}
    </AdminPage>
  );
}
