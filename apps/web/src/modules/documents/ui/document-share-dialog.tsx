import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { MembersDialog } from "~/modules/sharing/ui/members-dialog.tsx";
import { m } from "~/paraglide/messages.js";
import { toastError } from "~/ui/error-toast.ts";
import { Button } from "~/ui/primitives/button";
import { Switch } from "~/ui/primitives/switch";
import { documentSharingQuery } from "../client/document-queries.ts";
import { publicDocumentPath, type DocumentShareChange, type EditableDocument } from "../schema.ts";
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
  const send = async (change: DocumentShareChange) => {
    await shareDocument({ data: { documentId: document.id, change } });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["documents", document.id] }),
      queryClient.invalidateQueries({ queryKey: ["documents", "library"] }),
    ]);
  };
  const link = sharing.data?.publicLink;
  return (
    <MembersDialog
      open={open}
      onOpenChange={onOpenChange}
      title={m.documents_share_title({ title: document.title })}
      description={m.documents_share_description()}
      owner={{ id: document.userId ?? "", name: sharing.data?.ownerName ?? "" }}
      members={sharing}
      manage={manage}
      onChange={send}
      footer={
        // Off stays reachable after the right to publish is gone.
        manage && link && (link.canPublish || link.token) ? (
          <PublicLink token={link.token} onChange={send} />
        ) : null
      }
    />
  );
}

function PublicLink({
  token,
  onChange,
}: {
  token: string | null;
  onChange: (change: DocumentShareChange) => Promise<void>;
}) {
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => onChange({ action: "setPublicLink", enabled }),
    onError: (error) => toastError(m.documents_public_link_failed(), error),
  });
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const url = token ? `${window.location.origin}${publicDocumentPath(token)}` : null;
  return (
    <div className="flex flex-col gap-3 border-t pt-4">
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-medium">{m.documents_public_link()}</span>
          <span className="text-muted-foreground text-xs">
            {m.documents_public_link_description()}
          </span>
        </div>
        <Switch
          aria-label={m.documents_public_link()}
          checked={token !== null}
          disabled={toggle.isPending}
          onCheckedChange={(enabled) => toggle.mutate(enabled)}
        />
      </div>
      {url ? (
        <div className="flex items-center gap-2">
          <code className="bg-muted min-w-0 flex-1 truncate rounded-2xl px-4 py-2 font-mono text-xs select-all">
            {url}
          </code>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void navigator.clipboard.writeText(url).then(() => {
                clearTimeout(timer.current);
                setCopied(true);
                timer.current = setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} strokeWidth={2} />
            {copied ? m.common_copied() : m.common_copy()}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
