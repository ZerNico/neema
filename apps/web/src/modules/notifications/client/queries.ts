import { queryOptions } from "@tanstack/react-query";
import { listPushDevices } from "../server/functions.ts";

export const pushDevicesQuery = queryOptions({
  queryKey: ["notifications", "push-devices"],
  queryFn: () => listPushDevices(),
});
