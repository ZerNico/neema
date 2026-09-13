import { FolderOpenIcon, LinkSquare02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useMutation } from "@tanstack/react-query";
import { Effect } from "effect";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import {
  DesktopError,
  UNOPENABLE_EXTENSIONS,
  type DesktopClient,
  type RevealMode,
} from "@chat/desktop-rpc";
import { fileExtension } from "~/modules/attachments/constants.ts";
import type { AttachmentPreviewTarget } from "~/modules/attachments/ui/attachment-preview.tsx";
import { AttachmentPreviewDialog } from "~/modules/attachments/ui/attachment-preview.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { useDesktop } from "../client/bridge.ts";

/**
 * The file a Work row points at, shown in the preview dialog the rest of the
 * app already uses for attachments.
 *
 * The bytes are read at click time through the bridge, never from the server:
 * the server keeps bounded summaries of a local call on purpose, and a file the
 * model wrote an hour ago may no longer say what the summary said. So this
 * shows the file as it is now, out of an object URL that dies with the dialog.
 */

/**
 * Which conversation's folders a path resolves against. The transcript renders
 * far below the view that knows the conversation, and every row would otherwise
 * carry an id it has no other use for.
 */
const LocalFileConversationContext = createContext<string | null>(null);

export function LocalFileConversationProvider({
  conversationId,
  children,
}: {
  conversationId: string;
  children: ReactNode;
}) {
  return (
    <LocalFileConversationContext.Provider value={conversationId}>
      {children}
    </LocalFileConversationContext.Provider>
  );
}

/** Read as bytes, because the picture is the thing rather than the source. */
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** The last segment, which is what the dialog titles itself with. */
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** The folder holding it, or null when the path names an attached folder. */
const parentOf = (path: string) => {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? null : path.slice(0, cut);
};

const blobUrl = (parts: BlobPart[], type: string) =>
  URL.createObjectURL(new Blob(parts, { type }));

const decode = (base64: string) => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

/** Runs a bridge call, turning its refusal into a rejection the caller reports. */
const run = async <A,>(effect: Effect.Effect<A, DesktopError>) => {
  const outcome = await Effect.runPromise(Effect.result(effect));
  if (outcome._tag === "Failure") throw outcome.failure;
  return outcome.success;
};

const readLocalFile = async (
  client: DesktopClient,
  conversationId: string,
  path: string,
): Promise<AttachmentPreviewTarget> => {
  const fileName = baseName(path);
  const extension = fileExtension(path);
  const imageType = IMAGE_MEDIA_TYPES[extension];
  if (imageType !== undefined || extension === "pdf") {
    const file = await run(client.readBinary({ conversationId, path }));
    return {
      fileName,
      size: file.bytes,
      kind: imageType === undefined ? "pdf" : "image",
      url: blobUrl([decode(file.base64)], file.mediaType),
    };
  }
  const file = await run(client.readFile({ conversationId, path }));
  // An SVG is markup, so the desktop hands it over as text, never as bytes.
  // `<img>` is what makes it safe: secure static mode runs no script and
  // fetches nothing. A half-read one holds no picture, so it falls back to
  // source.
  const drawable = extension === "svg" && !file.truncated;
  const blob = new Blob([file.text], { type: drawable ? "image/svg+xml" : "text/plain" });
  return {
    fileName,
    size: blob.size,
    kind: drawable ? "image" : "text",
    url: URL.createObjectURL(blob),
    truncated: file.truncated,
  };
};

const refusalCopy = (reason: DesktopError["reason"]) => {
  switch (reason) {
    case "not-found":
      return "This file isn’t there anymore.";
    case "not-a-file":
      return "This is a folder, not a file.";
    case "no-folder":
    case "outside-folder":
      return "This chat can’t reach that folder on this computer anymore.";
    case "not-text":
    case "not-binary":
      return "There’s no preview for this kind of file.";
    case "too-large":
      return "This file is too large to show here.";
    default:
      return "This file couldn’t be read.";
  }
};

const reveal = (client: DesktopClient, conversationId: string, path: string, mode: RevealMode) =>
  run(client.revealPath({ conversationId, path, mode }));

/**
 * Beside the file name, so the label gives way before the buttons do. The
 * label is also the accessible name, which does not move with the breakpoint.
 */
function Action({
  icon,
  label,
  pending,
  onClick,
}: {
  icon: IconSvgElement;
  label: string;
  pending: boolean;
  onClick: () => void;
}) {
  return (
    <PendingButton
      size="sm"
      variant="outline"
      aria-label={label}
      pending={pending}
      onClick={onClick}
    >
      <HugeiconsIcon icon={icon} strokeWidth={2} data-icon="inline-start" aria-hidden />
      <span className="hidden sm:inline">{label}</span>
    </PendingButton>
  );
}

function LocalFileActions({
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
      toast.error(
        error instanceof DesktopError ? error.message : "That could not be opened.",
      ),
  });
  // A button that can only ever refuse is worse than no button. The desktop
  // still checks, and still refuses a file marked executable, which no
  // extension reveals.
  const openable = !UNOPENABLE_EXTENSIONS.has(`.${fileExtension(path)}`);
  return (
    <>
      <Action
        icon={FolderOpenIcon}
        label="Show in folder"
        pending={act.isPending && act.variables === "reveal"}
        onClick={() => act.mutate("reveal")}
      />
      {openable ? (
        <Action
          icon={LinkSquare02Icon}
          label="Open"
          pending={act.isPending && act.variables === "open"}
          onClick={() => act.mutate("open")}
        />
      ) : null}
    </>
  );
}

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
  const conversationId = useContext(LocalFileConversationContext);
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
      live.current = opened.url;
      setTarget(opened);
    },
    onError: (error) => {
      const folder = path === null ? null : parentOf(path);
      toast.error(
        error instanceof DesktopError ? refusalCopy(error.reason) : "This file couldn’t be read.",
        folder === null || client === null || conversationId === null
          ? undefined
          : {
              // A file that is gone cannot be shown, but its folder can.
              action: {
                label: "Show in folder",
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
          actions={
            <LocalFileActions client={client} conversationId={conversationId} path={path} />
          }
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
