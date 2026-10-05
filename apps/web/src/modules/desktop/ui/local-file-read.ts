import { Effect } from "effect";
import { DesktopError, type DesktopClient, type RevealMode } from "@chat/desktop-rpc";
import { fileExtension } from "~/modules/attachments/constants.ts";
import type { AttachmentPreviewTarget } from "~/modules/attachments/ui/attachment-preview.tsx";

/** Read as bytes, because the picture is the thing rather than the source. */
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

// A POSIX filename may contain backslashes; only Windows paths treat them as separators.
const lastSeparator = (path: string) =>
  Math.max(
    path.lastIndexOf("/"),
    /^(?:[a-z]:[\\/]|\\\\)/i.test(path) ? path.lastIndexOf("\\") : -1,
  );

/** The last segment, which is what the dialog titles itself with. */
const baseName = (path: string) => path.slice(lastSeparator(path) + 1);

/** The folder holding it, or null when the path names an attached folder. */
export const parentOf = (path: string) => {
  const cut = lastSeparator(path);
  if (cut === -1) return null;
  return path.slice(0, cut === 0 || (cut === 2 && path[1] === ":") ? cut + 1 : cut);
};

const blobUrl = (parts: BlobPart[], type: string) => URL.createObjectURL(new Blob(parts, { type }));

const decode = (base64: string) => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

/** Runs a bridge call, turning its refusal into a rejection the caller reports. */
const run = async <A>(effect: Effect.Effect<A, DesktopError>) => {
  const outcome = await Effect.runPromise(Effect.result(effect));
  if (outcome._tag === "Failure") throw outcome.failure;
  return outcome.success;
};

export const readLocalFile = async (
  client: DesktopClient,
  conversationId: string,
  path: string,
): Promise<AttachmentPreviewTarget> => {
  const fileName = baseName(path);
  const extension = fileExtension(path);
  const imageType = IMAGE_MEDIA_TYPES[extension];
  if (imageType !== undefined || extension === "pdf") {
    const file = await run(
      client.readBinary({ conversationId, path, callId: crypto.randomUUID(), purpose: "view" }),
    );
    return {
      fileName,
      size: file.bytes,
      kind: imageType === undefined ? "pdf" : "image",
      url: blobUrl([decode(file.base64)], file.mediaType),
    };
  }
  try {
    const file = await run(client.readFile({ conversationId, path, callId: crypto.randomUUID() }));
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
  } catch (error) {
    // A binary file is still worth opening: the dialog shows the "no preview"
    // body with its actions, which beats a bare toast.
    if (error instanceof DesktopError && error.reason === "not-text") {
      const info = await run(
        client.fileInfo({ conversationId, path, callId: crypto.randomUUID() }),
      );
      return {
        fileName,
        size: info.bytes,
        kind: "text",
        url: "",
        unsupported: true,
      };
    }
    throw error;
  }
};

export const refusalCopy = (reason: DesktopError["reason"]) => {
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

export const reveal = (
  client: DesktopClient,
  conversationId: string,
  path: string,
  mode: RevealMode,
) => run(client.revealPath({ conversationId, path, mode }));
