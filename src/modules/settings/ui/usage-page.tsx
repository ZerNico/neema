import { Analytics01Icon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { startTransition, useState } from "react";
import { AdminPage, EmptyState } from "~/modules/admin/ui/admin-shell.tsx";
import { myUsageQuery } from "~/modules/analytics/client/queries.ts";
import { DEFAULT_USAGE_RANGE, type UsageRangeEncoded } from "~/modules/analytics/schema.ts";
import { UsageOverview, UsageRangePicker } from "~/modules/analytics/ui/usage-dashboard.tsx";

export function UsagePage() {
  const [range, setRange] = useState<UsageRangeEncoded>(DEFAULT_USAGE_RANGE);
  const { data } = useSuspenseQuery(myUsageQuery(range));
  const changeRange = (next: UsageRangeEncoded) => {
    // Keep the previous dashboard visible while the new range loads.
    startTransition(() => setRange(next));
  };

  return (
    <AdminPage
      title="Usage"
      description="Your own token usage and messages, including retries and title generations."
      rootPath="/settings"
      rootLabel="Settings"
      actions={<UsageRangePicker range={range} onChange={changeRange} />}
    >
      {data.daily.length === 0 ? (
        <EmptyState
          icon={Analytics01Icon}
          title="No usage in this range"
          description="Your generations land here as you chat — tokens, messages and cost, including retries and title runs."
        />
      ) : (
        <UsageOverview
          summary={data.summary}
          daily={data.daily}
          byModel={data.byModel}
          previousSummary={data.previousSummary}
          window={data.window}
          showActiveUsers={false}
        />
      )}
    </AdminPage>
  );
}
