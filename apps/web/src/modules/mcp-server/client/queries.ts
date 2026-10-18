import { queryOptions } from "@tanstack/react-query";
import { listConnectedApps } from "../server/functions.ts";

export const connectedAppsQuery = queryOptions({
  queryKey: ["connected-apps"],
  queryFn: () => listConnectedApps(),
});
