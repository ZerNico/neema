import { Analytics01Icon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { startTransition, useState } from "react";
import { myUsageQuery } from "~/modules/analytics/client/queries.ts";
import { DEFAULT_USAGE_RANGE, type UsageRangeEncoded } from "~/modules/analytics/schema.ts";
import { UsageOverview, UsageRangePicker } from "~/modules/analytics/ui/usage-dashboard.tsx";
import { MyLimitsSection } from "~/modules/limits/ui/my-limits-section.tsx";
import { EmptyState, Page } from "~/ui/page-shell.tsx";
import { m } from "~/paraglide/messages.js";

export function UsagePage() {
  const [range, setRange] = useState<UsageRangeEncoded>(DEFAULT_USAGE_RANGE);
  const { data } = useSuspenseQuery(myUsageQuery(range));
  const changeRange = (next: UsageRangeEncoded) => {
    // Keep the previous dashboard visible while the new range loads.
    startTransition(() => setRange(next));
  };

  return (
    <Page
      title={m.settings_section_usage()}
      rootPath="/settings"
      rootLabel={m.common_settings()}
      width="wide"
      actions={<UsageRangePicker range={range} onChange={changeRange} />}
    >
      <MyLimitsSection />
      {data.daily.length === 0 ? (
        <EmptyState
          icon={Analytics01Icon}
          title={m.settings_usage_empty_title()}
          description={m.settings_usage_empty_description()}
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
    </Page>
  );
}
