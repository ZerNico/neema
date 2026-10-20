import { queryOptions } from "@tanstack/react-query";
import { getMyLimits, getUsageLimitRules } from "../server/functions.ts";

export const myLimitsQuery = queryOptions({
  queryKey: ["my-limits"],
  queryFn: () => getMyLimits(),
  staleTime: 30_000,
});

export const usageLimitRulesQuery = queryOptions({
  queryKey: ["admin", "usage-limits"],
  queryFn: () => getUsageLimitRules(),
});
