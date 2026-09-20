import { useEffect, useState } from "react";
import { Effect } from "effect";
import { attachmentKind } from "~/modules/attachments/constants.ts";
import { AttachmentChip } from "~/modules/attachments/ui/attachment-chip.tsx";
import { useDesktop } from "../client/bridge.ts";
import { useLocalFileConversation, useLocalFilePreview } from "./local-file-preview.tsx";

/** Plain-text fallback, so an unknown extension still reads as a text file. */
const guessKind = (fileName: string) =>
  attachmentKind(/\.(png|jpe?g|gif|webp|svg)$/i.test(fileName) ? "image/png" : "text/plain");

/** Builds the chip target once the size is known, or before it with a guess. */
const toPath = (root: string | null, fileName: string) =>
  root === null ? null : `${root}/${fileName}`;

/**
 * A file a send copied into the chat's workspace, rendered like an
 * attachment chip: click previews through the bridge, and the dialog carries
 * the "Show in folder" and "Open" actions.
 *
 * The chip subtitle shows the real size once `fileInfo` answers. In a browser
 * there is no bridge, so the chip renders inert history: the transcript
 * stays readable where the machine cannot be reached.
 */
export function WorkspaceFileChip({ fileName }: { fileName: string }) {
  const client = useDesktop();
  const conversationId = useLocalFileConversation();
  const [root, setRoot] = useState<string | null>(null);
  const [bytes, setBytes] = useState<number | null>(null);

  // Resolved at render time rather than handed down: the transcript sits far
  // below the folder strip, and the row would otherwise carry the workspace
  // path for no other reason. A missing workspace reports no size, nothing more.
  useEffect(() => {
    if (!client || !conversationId) return;
    let stale = false;
    void Effect.runPromise(Effect.result(client.folderStatus({ conversationId }))).then(
      (outcome) => {
        if (stale || outcome._tag === "Failure") return;
        const workspace = outcome.success.workspace;
        if (!workspace) return;
        setRoot(workspace.path);
        void Effect.runPromise(
          Effect.result(
            client.fileInfo({
              conversationId,
              path: `${workspace.path}/${fileName}`,
              callId: crypto.randomUUID(),
            }),
          ),
        ).then((info) => {
          if (!stale && info._tag === "Success") setBytes(info.success.bytes);
        });
      },
    );
    return () => {
      stale = true;
    };
  }, [client, conversationId, fileName]);

  const preview = useLocalFilePreview(toPath(root, fileName));

  return (
    <>
      <AttachmentChip
        item={{
          fileName,
          size: bytes ?? 0,
          kind: guessKind(fileName),
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
