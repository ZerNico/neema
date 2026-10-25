import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { toastError } from "~/ui/error-toast.ts";
import { DEFAULT_PINS, normalizePins, type DestinationId, type SidebarPins } from "../schema.ts";
import { getSidebarPins, updateSidebarPins } from "../server/functions.ts";
import { m } from "~/paraglide/messages.js";

export const sidebarPinsQuery = queryOptions({
  queryKey: ["sidebar", "pins"],
  queryFn: () => getSidebarPins(),
  staleTime: 5 * 60_000,
});

export const togglePin = (pinned: ReadonlyArray<DestinationId>, id: DestinationId) =>
  pinned.includes(id) ? pinned.filter((each) => each !== id) : normalizePins([...pinned, id]);

/**
 * Flips one pin at once. A failed save flips only that pin back, and a save
 * queued behind it sends the list as it stands when its turn comes, so the
 * failed toggle is neither kept nor takes later ones with it.
 */
export function useTogglePin() {
  const queryClient = useQueryClient();
  const key = sidebarPinsQuery.queryKey;
  const current = () => queryClient.getQueryData<SidebarPins>(key)?.pinned ?? DEFAULT_PINS;
  const flip = (id: DestinationId) =>
    queryClient.setQueryData<SidebarPins>(key, { pinned: togglePin(current(), id) });
  return useMutation({
    // One save at a time, so quick toggles reach the server in the order made.
    mutationKey: key,
    scope: { id: "sidebar-pins" },
    mutationFn: (_id: DestinationId) => updateSidebarPins({ data: { pinned: current() } }),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: key });
      flip(id);
    },
    onError: (error, id) => {
      flip(id);
      toastError(m.navigation_error_pins(), error);
    },
    // A refetch between two queued saves would briefly undo the second one.
    onSettled: () =>
      queryClient.isMutating({ mutationKey: key }) === 1
        ? queryClient.invalidateQueries({ queryKey: key })
        : undefined,
  });
}
