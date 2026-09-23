import { queryOptions } from "@tanstack/react-query";
import { getMyCapabilities } from "../server/functions.ts";

export const capabilitiesQuery = queryOptions({
  queryKey: ["capabilities"],
  queryFn: () => getMyCapabilities(),
});
