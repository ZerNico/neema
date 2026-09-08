import { queryOptions } from "@tanstack/react-query";
import type { SharedResource } from "../schema.ts";
import { getResourceSharing } from "../server/functions.ts";

export const resourceSharingQuery = (resource: SharedResource) =>
  queryOptions({
    queryKey: ["sharing", resource.kind, resource.id],
    queryFn: () => getResourceSharing({ data: resource }),
    staleTime: 10_000,
  });
