import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import type { UsageRangeEncoded } from "../schema.ts";
import { getMyUsage, getUsageAnalytics } from "../server/functions.ts";

/**
 * Presets keep their original bare-number key (`[..., 30]`) so the route
 * loaders' prefetch still matches what the page asks for; custom windows get
 * their boundaries in the key, which is what makes them cacheable at all.
 */
const rangeKey = (range: UsageRangeEncoded): ReadonlyArray<string | number> =>
  range.kind === "preset" ? [range.days] : ["custom", range.from, range.to];

export const adminUsageQuery = (range: UsageRangeEncoded) =>
  queryOptions({
    queryKey: ["admin", "analytics", ...rangeKey(range)],
    queryFn: () => getUsageAnalytics({ data: range }),
    staleTime: 30_000,
    // Changing range swaps the key; hold the old dashboard rather than
    // suspending the whole page back to a skeleton.
    placeholderData: keepPreviousData,
  });

export const myUsageQuery = (range: UsageRangeEncoded) =>
  queryOptions({
    queryKey: ["my-usage", ...rangeKey(range)],
    queryFn: () => getMyUsage({ data: range }),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
