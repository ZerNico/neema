import { useQueryClient } from "@tanstack/react-query";

export const useInvalidateTools = (availabilityKey: string) => {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["admin", "tools"] }),
      queryClient.invalidateQueries({ queryKey: ["tools", availabilityKey, "availability"] }),
    ]);
};
