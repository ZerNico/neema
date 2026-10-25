import { useMutation } from "@tanstack/react-query";
import { useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { DesktopError } from "@chat/desktop-rpc";
import type { AttachmentPreviewTarget } from "~/modules/attachments/ui/attachment-preview.tsx";
import { AttachmentPreviewDialog } from "~/modules/attachments/ui/attachment-preview.tsx";
import { useDesktop } from "../client/bridge.ts";
import { LocalFileConversationContext } from "./local-file-context.ts";
import { LocalFileActions } from "./local-file-preview.tsx";
import { parentOf, readLocalFile, refusalCopy, reveal } from "./local-file-read.ts";
import { m } from "~/paraglide/messages.js";

export interface LocalFilePreview {
  /** Reads the file and opens the dialog. Nothing touches disk before this. */
  readonly open: () => void;
  /** Render beside the row: the dialog only exists while a file is open. */
  readonly dialog: ReactNode;
}

/**
 * Opens `path` in the attachment preview dialog, or null when there is nothing
 * to open it with: a browser has no bridge, and the row stays history there.
 */
export function useLocalFilePreview(path: string | null): LocalFilePreview | null {
  const client = useDesktop();
  const local = useContext(LocalFileConversationContext);
  const conversationId = local?.conversationId ?? null;
  const [target, setTarget] = useState<AttachmentPreviewTarget | null>(null);
  // An object URL outlives the render that made it, so the last one has to be
  // reachable from teardown as well as from the close that usually revokes it.
  const live = useRef<string | null>(null);
  const release = () => {
    if (live.current !== null) URL.revokeObjectURL(live.current);
    live.current = null;
  };
  // Reads the ref rather than closing over `release`, so teardown needs no
  // dependency and still gives back whichever URL is open at the time.
  useEffect(
    () => () => {
      if (live.current !== null) URL.revokeObjectURL(live.current);
    },
    [],
  );

  const read = useMutation({
    mutationFn: () => readLocalFile(client!, conversationId!, path!),
    onSuccess: (opened) => {
      release();
      // An unsupported file carries no object URL to hold on to.
      live.current = opened.url === "" ? null : opened.url;
      setTarget(opened);
    },
    onError: (error) => {
      const folder = path === null ? null : parentOf(path);
      toast.error(
        error instanceof DesktopError ? refusalCopy(error.reason) : m.desktop_file_unreadable(),
        folder === null || client === null || conversationId === null
          ? undefined
          : {
              // A file that is gone cannot be shown, but its folder can.
              action: {
                label: m.desktop_file_show_in_folder(),
                onClick: () => {
                  void reveal(client, conversationId, folder, "reveal").catch(() => {});
                },
              },
            },
      );
    },
  });

  if (client === null || path === null || conversationId === null) return null;
  return {
    open: () => {
      if (!read.isPending) read.mutate();
    },
    dialog:
      target === null ? null : (
        <AttachmentPreviewDialog
          target={target}
          actions={<LocalFileActions client={client} conversationId={conversationId} path={path} />}
          open
          onOpenChange={(next) => {
            if (next) return;
            release();
            setTarget(null);
          }}
        />
      ),
  };
}
