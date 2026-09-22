import { queryOptions } from "@tanstack/react-query";
import { listSeenFeatures } from "../server/functions.ts";

export const seenFeaturesQuery = queryOptions({
  queryKey: ["seen-features"],
  queryFn: () => listSeenFeatures(),
  // Changes only when this person closes a tour.
  staleTime: Number.POSITIVE_INFINITY,
});
