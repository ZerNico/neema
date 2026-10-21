import { queryOptions } from "@tanstack/react-query";
import {
  getMyLimits,
  getMyStorage,
  getStorageQuotas,
  getUsageLimitRules,
} from "../server/functions.ts";

export const myLimitsQuery = queryOptions({
  queryKey: ["my-limits"],
  queryFn: () => getMyLimits(),
  staleTime: 30_000,
});

export const usageLimitRulesQuery = queryOptions({
  queryKey: ["admin", "usage-limits"],
  queryFn: () => getUsageLimitRules(),
});

export const myStorageQuery = queryOptions({
  queryKey: ["my-storage"],
  queryFn: () => getMyStorage(),
  staleTime: 30_000,
});

export const storageQuotasQuery = queryOptions({
  queryKey: ["admin", "storage-quotas"],
  queryFn: () => getStorageQuotas(),
});
