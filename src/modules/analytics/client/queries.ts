import { queryOptions } from "@tanstack/react-query";
import type { UsageRangeDays } from "../schema.ts";
import { getMyUsage, getUsageAnalytics } from "../server/functions.ts";

export const adminUsageQuery = (days: UsageRangeDays) =>
  queryOptions({
    queryKey: ["admin", "analytics", days],
    queryFn: () => getUsageAnalytics({ data: { days } }),
    staleTime: 30_000,
  });

export const myUsageQuery = (days: UsageRangeDays) =>
  queryOptions({
    queryKey: ["my-usage", days],
    queryFn: () => getMyUsage({ data: { days } }),
    staleTime: 30_000,
  });
