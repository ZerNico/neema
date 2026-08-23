import { useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { AdminPage } from "~/modules/admin/ui/admin-shell.tsx";
import { myUsageQuery } from "~/modules/analytics/client/queries.ts";
import type { UsageRangeDays } from "~/modules/analytics/schema.ts";
import { UsageOverview, UsageRangeSelect } from "~/modules/analytics/ui/usage-dashboard.tsx";

export function UsagePage() {
  const [days, setDays] = useState<UsageRangeDays>(30);
  const { data } = useSuspenseQuery(myUsageQuery(days));

  return (
    <AdminPage
      title="Usage"
      description="Your own token usage and messages, including retries and title generations."
      rootPath="/settings"
      rootLabel="Settings"
      actions={<UsageRangeSelect days={days} onChange={setDays} />}
    >
      <UsageOverview
        summary={data.summary}
        daily={data.daily}
        byModel={data.byModel}
        days={days}
        showActiveUsers={false}
      />
    </AdminPage>
  );
}
