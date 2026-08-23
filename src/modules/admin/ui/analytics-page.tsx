import { useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { AdminPage } from "./admin-shell.tsx";
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
      <UsageOverview
        summary={data.summary}
        daily={data.daily}
        byModel={data.byModel}
        days={days}
        showActiveUsers
      />
      <ChartCard title="By user">
        {data.byUser.length === 0 ? (
          <p className="text-muted-foreground text-sm">No usage recorded yet.</p>
        ) : (
          <UsersTable byUser={data.byUser} />
        )}
      </ChartCard>
    </AdminPage>
  );
}
