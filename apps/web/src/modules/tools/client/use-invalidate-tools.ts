import { useQueryClient } from "@tanstack/react-query";
import { composerAvailabilityQuery } from "~/modules/chat/client/queries.ts";

/** After an admin tool change: the admin rows, and what composers may offer. */
export const useInvalidateTools = () => {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["admin", "tools"] }),
      queryClient.invalidateQueries({ queryKey: composerAvailabilityQuery.queryKey }),
    ]);
};
