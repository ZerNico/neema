import { ComputerIcon, MultiplicationSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { useState } from "react";
import { toast } from "sonner";
import { desktopClient, folderQueryKey } from "../client/bridge.ts";
import { settled } from "./foreign-machine-stamp.ts";

/**
 * Shown in a work chat whose latest attempt was sent from another machine. The
 * workspace and attached folders live there, so this machine starts from an
 * empty workspace until the user takes over. A reinstall mints a new machine
 * id, so this is also the flow for "same computer, new install".
 *
 * Taking over is local-only: it materializes this machine's workspace for the
 * chat (the ordinary status read ensures it) and clears the banner. Nothing is
 * copied from the other machine, and folder grants are per-machine by design.
 */
export function ForeignMachineBanner({
  conversationId,
  stamp,
}: {
  conversationId: string;
  stamp: { id: string; name: string | null };
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const settle = () => settled.set(conversationId, stamp.id);
  const takeOver = async () => {
    if (!desktopClient()) return;
    setBusy(true);
    try {
      // The status read is what materializes this machine's workspace: the
      // shell ensures it on every folderStatus call, and invalidating puts the
      // strip on the fresh state. The banner itself clears via `settle`.
      await queryClient.fetchQuery({
        queryKey: folderQueryKey(conversationId),
        queryFn: () => Effect.runPromise(desktopClient()!.folderStatus({ conversationId })),
        staleTime: 0,
      });
      settle();
    } catch {
      setBusy(false);
      toast.error("Could not take over this chat.");
    }
  };
  return (
    <div className="mx-auto flex w-full max-w-3xl items-center gap-2 px-4 pb-2 text-xs">
      <div
        role="status"
        className="bg-muted/60 text-muted-foreground flex min-w-0 flex-1 items-center gap-1.5 rounded-lg border px-3 py-1.5"
      >
        <HugeiconsIcon icon={ComputerIcon} strokeWidth={2} className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">
          This chat last worked on{" "}
          <strong className="text-foreground">{stamp.name ?? "another computer"}</strong>
          {"; its workspace and attached folders live there."}
        </span>
        <button
          type="button"
          className="text-foreground hover:bg-muted shrink-0 rounded-md px-2 py-1 font-medium disabled:opacity-50"
          disabled={busy}
          onClick={() => void takeOver()}
        >
          Take over on this Mac
        </button>
        <button
          type="button"
          aria-label="Dismiss"
          className="hover:text-foreground shrink-0 rounded-md p-1"
          onClick={settle}
        >
          <HugeiconsIcon icon={MultiplicationSignIcon} strokeWidth={2} className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
