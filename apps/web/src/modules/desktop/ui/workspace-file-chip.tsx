import { useQuery } from "@tanstack/react-query";
import { Effect } from "effect";
import { attachmentKindForFileName } from "~/modules/attachments/constants.ts";
import { AttachmentChip } from "~/modules/attachments/ui/attachment-chip.tsx";
import { useDesktop } from "../client/bridge.ts";
import { useLocalFileConversation, useLocalFilePreview } from "./local-file-preview.tsx";

/**
 * A file a send committed to the chat workspace. The provider already owns the
 * folder-status read, so chips only ask for metadata and share it through the
 * React Query key across virtualization remounts and duplicate history rows.
 */
export function WorkspaceFileChip({ fileName }: { fileName: string }) {
  const client = useDesktop();
  const local = useLocalFileConversation();
  const path = local?.workspaceRoot ? `${local.workspaceRoot}/${fileName}` : null;
  const info = useQuery({
    queryKey: ["desktop-file-info", local?.conversationId, path],
    enabled: client !== null && local !== null && path !== null,
    queryFn: ({ signal }) =>
      Effect.runPromise(
        client!.fileInfo({
          conversationId: local!.conversationId,
          path: path!,
          callId: crypto.randomUUID(),
        }),
        { signal },
      ),
    staleTime: Infinity,
    retry: false,
  });
  const preview = useLocalFilePreview(path);

  return (
    <>
      <AttachmentChip
        item={{
          fileName,
          size: info.data?.bytes ?? 0,
          kind: attachmentKindForFileName(fileName),
          location: "workspace",
        }}
        onRemove={undefined}
        preview={null}
        onOpenPreview={preview ? preview.open : undefined}
      />
      {preview?.dialog}
    </>
  );
}
