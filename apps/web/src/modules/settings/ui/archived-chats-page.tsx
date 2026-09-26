import { Archive02Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { archivedConversationsQuery } from "~/modules/chat/client/queries.ts";
import { archiveAllConversations } from "~/modules/chat/server/functions.ts";
import { useConfirm } from "~/ui/confirm.tsx";
import { toastError } from "~/ui/error-toast.ts";
import { ListCard, ListRow, Page } from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";

export function ArchivedChatsPage() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { data: archived } = useSuspenseQuery(archivedConversationsQuery);

  const archiveAll = useMutation({
    mutationFn: () => archiveAllConversations(),
    onSuccess: async (count) => {
      await queryClient.invalidateQueries({ queryKey: ["conversations"] });
      toast(
        count === 0 ? "No chats to archive" : `Archived ${count} chat${count === 1 ? "" : "s"}`,
      );
    },
    onError: (error) => toastError("Could not archive the chats.", error),
  });

  return (
    <Page title="Archived chats" rootPath="/settings" rootLabel="Settings">
      <ListCard>
        {/* The list itself lives on the Chats page, beside the chats it came from. */}
        <ListRow interactive className="p-0">
          <Link to="/chats/archived" className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3">
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm font-medium">Archived chats</span>
              <span className="text-muted-foreground text-xs">
                {archived.length === 0
                  ? "None yet"
                  : `${archived.length} chat${archived.length === 1 ? "" : "s"}`}
              </span>
            </span>
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              strokeWidth={2}
              className="text-muted-foreground size-4 shrink-0"
            />
          </Link>
        </ListRow>
        <ListRow>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-sm font-medium">Archive all chats</span>
            <span className="text-muted-foreground text-xs">
              Move every chat out of your sidebar.
            </span>
          </span>
          <PendingButton
            variant="outline"
            size="sm"
            pending={archiveAll.isPending}
            onClick={async () => {
              if (
                await confirm({
                  title: "Archive all chats?",
                  description: "You can unarchive them any time from Archived chats.",
                  confirmLabel: "Archive all",
                })
              )
                archiveAll.mutate();
            }}
          >
            <HugeiconsIcon icon={Archive02Icon} strokeWidth={2} />
            Archive all
          </PendingButton>
        </ListRow>
      </ListCard>
    </Page>
  );
}
