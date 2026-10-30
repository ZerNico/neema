import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MembersDialog } from "~/modules/sharing/ui/members-dialog.tsx";
import { m } from "~/paraglide/messages.js";
import { documentSharingQuery } from "../client/document-queries.ts";
import type { EditableDocument } from "../schema.ts";
import { shareDocument } from "../server/document-functions.ts";

/** Who a person's document is shared with; its owner changes it, everyone else sees it. */
export function DocumentShareDialog({
  document,
  manage,
  open,
  onOpenChange,
}: {
  document: Pick<EditableDocument, "id" | "title" | "userId">;
  manage: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const sharing = useQuery({ ...documentSharingQuery(document.id), enabled: open });
  return (
    <MembersDialog
      open={open}
      onOpenChange={onOpenChange}
      title={m.documents_share_title({ title: document.title })}
      description={m.documents_share_description()}
      owner={{ id: document.userId ?? "", name: sharing.data?.ownerName ?? "" }}
      members={sharing}
      manage={manage}
      onChange={async (change) => {
        await shareDocument({ data: { documentId: document.id, change } });
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["documents", document.id] }),
          queryClient.invalidateQueries({ queryKey: ["documents", "library"] }),
        ]);
      }}
    />
  );
}
