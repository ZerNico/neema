import { queryOptions } from "@tanstack/react-query";
import {
  getMyLibrary,
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

// Always fresh when the page opens or its tab comes back: an upload elsewhere sends no event.
export const myStorageQuery = queryOptions({
  queryKey: ["my-storage"],
  queryFn: () => getMyStorage(),
  staleTime: 0,
  refetchOnWindowFocus: "always",
});

export const storageQuotasQuery = queryOptions({
  queryKey: ["admin", "storage-quotas"],
  queryFn: () => getStorageQuotas(),
});

export const myLibraryQuery = queryOptions({
  queryKey: ["my-storage", "library"],
  queryFn: () => getMyLibrary(),
  staleTime: 0,
  refetchOnWindowFocus: "always",
});
