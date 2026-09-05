import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import type { UsageRangeEncoded } from "../schema.ts";
import { getMyUsage, getUsageAnalytics } from "../server/functions.ts";

export const adminUsageQuery = (range: UsageRangeEncoded) =>
  queryOptions({
    queryKey: ["admin", "analytics", range],
    queryFn: () => getUsageAnalytics({ data: range }),
    staleTime: 30_000,
    // Changing range swaps the key; hold the old dashboard rather than
    // suspending the whole page back to a skeleton.
    placeholderData: keepPreviousData,
  });

export const myUsageQuery = (range: UsageRangeEncoded) =>
  queryOptions({
    queryKey: ["my-usage", range],
    queryFn: () => getMyUsage({ data: range }),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
