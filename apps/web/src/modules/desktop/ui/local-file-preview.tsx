import { FolderOpenIcon, LinkSquare02Icon } from "@hugeicons/core-free-icons";
import { useMutation } from "@tanstack/react-query";
import { useMemo, type ReactNode } from "react";
import { toast } from "sonner";
import {
  DesktopError,
  OPENABLE_EXTENSIONS,
  type DesktopClient,
  type RevealMode,
} from "@chat/desktop-rpc";
import { fileExtension } from "~/modules/attachments/constants.ts";
import { PreviewAction } from "~/modules/attachments/ui/preview-action.tsx";
import { LocalFileConversationContext } from "./local-file-context.ts";
import { reveal } from "./local-file-read.ts";

/**
 * The file a Work row points at, shown in the preview dialog the rest of the
 * app already uses for attachments.
 *
 * The bytes are read at click time through the bridge, never from the server:
 * the server keeps bounded summaries of a local call on purpose, and a file the
 * model wrote an hour ago may no longer say what the summary said. So this
 * shows the file as it is now, out of an object URL that dies with the dialog.
 */

export function LocalFileConversationProvider({
  conversationId,
  workspaceRoot,
  children,
}: {
  conversationId: string;
  workspaceRoot?: string | null;
  children: ReactNode;
}) {
  // One object per conversation, so consumers re-render only when it changes.
  const value = useMemo(
    () => ({ conversationId, workspaceRoot: workspaceRoot ?? null }),
    [conversationId, workspaceRoot],
  );
  return (
    <LocalFileConversationContext.Provider value={value}>
      {children}
    </LocalFileConversationContext.Provider>
  );
}

/**
 * Beside the file name, so the label gives way before the buttons do. The
 * label is also the accessible name, which does not move with the breakpoint.
 */
export function LocalFileActions({
  client,
  conversationId,
  path,
}: {
  client: DesktopClient;
  conversationId: string;
  path: string;
}) {
  const act = useMutation({
    mutationFn: (mode: RevealMode) => reveal(client, conversationId, path, mode),
    // The header row has no room for a sentence, and the desktop's refusals
    // are already written as ones the reader can act on.
    onError: (error) =>
      toast.error(error instanceof DesktopError ? error.message : "That could not be opened."),
  });
  // A button that can only ever refuse is worse than no button. The desktop
  // still checks, and still refuses a file marked executable, which no
  // extension reveals.
  const openable = OPENABLE_EXTENSIONS.has(`.${fileExtension(path)}`);
  return (
    <>
      <PreviewAction
        icon={FolderOpenIcon}
        label="Show in folder"
        pending={act.isPending && act.variables === "reveal"}
        onClick={() => act.mutate("reveal")}
      />
      {openable ? (
        <PreviewAction
          icon={LinkSquare02Icon}
          label="Open"
          pending={act.isPending && act.variables === "open"}
          onClick={() => act.mutate("open")}
        />
      ) : null}
    </>
  );
}
