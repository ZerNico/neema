import { queryOptions } from "@tanstack/react-query";
import { listApiKeys } from "../server/functions.ts";

export const apiKeysQuery = queryOptions({
  queryKey: ["api-keys"],
  queryFn: () => listApiKeys(),
});
