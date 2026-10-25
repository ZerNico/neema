import { Archive02Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { archivedConversationsQuery } from "~/modules/chat/client/queries.ts";
import { archiveAllConversations } from "~/modules/chat/server/functions.ts";
import { useConfirm } from "~/ui/confirm-context.ts";
import { toastError } from "~/ui/error-toast.ts";
import { ListCard, ListRow, Page } from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { m } from "~/paraglide/messages.js";

export function ArchivedChatsPage() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { data: archived } = useSuspenseQuery(archivedConversationsQuery);

  const archiveAll = useMutation({
    mutationFn: () => archiveAllConversations(),
    onSuccess: async (count) => {
      await queryClient.invalidateQueries({ queryKey: ["conversations"] });
      toast(
        count === 0 ? m.settings_archived_none_to_archive() : m.settings_archived_done({ count }),
      );
    },
    onError: (error) => toastError(m.settings_archived_error(), error),
  });

  return (
    <Page
      title={m.settings_section_archived()}
      rootPath="/settings"
      rootLabel={m.common_settings()}
    >
      <ListCard>
        {/* The list itself lives on the Chats page, beside the chats it came from. */}
        <ListRow interactive className="p-0">
          <Link to="/chats/archived" className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3">
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm font-medium">{m.settings_section_archived()}</span>
              <span className="text-muted-foreground text-xs">
                {archived.length === 0
                  ? m.settings_archived_none_yet()
                  : m.settings_archived_count({ count: archived.length })}
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
            <span className="text-sm font-medium">{m.settings_archived_all_title()}</span>
            <span className="text-muted-foreground text-xs">
              {m.settings_archived_all_description()}
            </span>
          </span>
          <PendingButton
            variant="outline"
            size="sm"
            pending={archiveAll.isPending}
            onClick={async () => {
              if (
                await confirm({
                  title: m.settings_archived_confirm_title(),
                  description: m.settings_archived_confirm_description(),
                  confirmLabel: m.settings_archived_all(),
                })
              )
                archiveAll.mutate();
            }}
          >
            <HugeiconsIcon icon={Archive02Icon} strokeWidth={2} />
            {m.settings_archived_all()}
          </PendingButton>
        </ListRow>
      </ListCard>
    </Page>
  );
}
