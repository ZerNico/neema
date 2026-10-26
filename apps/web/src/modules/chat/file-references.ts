import type { Attachment } from "~/modules/attachments/schema.ts";
import type { FileReferenceAliases } from "./file-reference-aliases.ts";

export const attachmentReferenceUrl = (id: string) => `/api/files/${encodeURIComponent(id)}`;

export const attachmentReferenceHint = (file: { id: string; fileName: string }) =>
  `File reference: ${JSON.stringify(file.fileName)}, attachment id ${JSON.stringify(file.id)}, link ${attachmentReferenceUrl(file.id)}.`;

export const fileReferencesSystemHint =
  "When referring to an available uploaded or tool-returned file, use a Markdown link [filename](/api/files/ATTACHMENT_ID) with its actual attachment id so the reader can preview it. Use the current file metadata, not ids copied from older answers. Never invent an id or identify a file by its name alone. When you deliver a new file, its preview and download card are already in the answer. A brief completion line is enough; do not repeat the file link or list its contents unless the reader asks for a breakdown or explanation.";

export const isFileReferenceHref = (href: string) =>
  /^\/(?:api\/files(?:\/|[?#]|$)|local-file(?:[/?#]|$))/.test(href);

export type FileReference = { kind: "attachment"; id: string } | { kind: "local"; path: string };

export function parseFileReference(href: string): FileReference | null {
  try {
    const attachment = /^\/api\/files\/([^/?#]+)$/.exec(href);
    if (attachment) {
      const id = decodeURIComponent(attachment[1]!);
      return /^[a-zA-Z0-9_-]+$/.test(id) ? { kind: "attachment", id } : null;
    }
    const local = /^\/local-file\?path=([^&#]+)$/.exec(href);
    if (!local || /%(?![\da-f]{2})/i.test(local[1]!)) return null;
    const path = decodeURIComponent(local[1]!.replaceAll("+", " "));
    return absoluteFilePath(path) ? { kind: "local", path } : null;
  } catch {
    return null;
  }
}

// Keep separators platform-specific: a backslash is a valid POSIX filename.
function absoluteFilePath(path: string) {
  if (
    !path ||
    Array.from(path).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    return null;
  const windows = /^[a-z]:[\\/]/i.test(path) || path.startsWith("\\\\") || path.startsWith("//");
  const normalized = windows ? path.replaceAll("\\", "/") : path;
  if (!windows && !normalized.startsWith("/")) return null;
  if (windows && normalized.startsWith("//") && !/^\/\/[^/]+\/[^/]+\//.test(normalized))
    return null;
  // Do not collapse traversal across a symlink before the desktop checks it.
  const parts = normalized.split("/");
  if (parts.some((part) => part === "." || part === "..")) return null;
  if (normalized.endsWith("/")) return null;
  return { normalized, windows };
}

export const localFileName = (path: string) => {
  const normalized = absoluteFilePath(path)?.normalized ?? path;
  return normalized.slice(normalized.lastIndexOf("/") + 1);
};

/**
 * The path a local file link opens, or null. Paths are the chat computer's guest paths, the same
 * on every machine and in every branch, so nothing is rewritten; a link opens only on the
 * machine that chat's computer runs on.
 */
export function resolveLocalReference(input: {
  path: string;
  machineId: string | null;
  originMachineId: string | null;
}): string | null {
  if (!input.machineId || input.machineId !== input.originMachineId) return null;
  return /^\/(?:workspace|folders\/[^/]+)(?:\/|$)/.test(input.path) ? input.path : null;
}

export function referenceAttachment(
  id: string,
  attachments: ReadonlyMap<string, Attachment>,
  aliases: FileReferenceAliases | null,
): Attachment | undefined {
  const direct = attachments.get(id);
  if (direct) return direct;
  const target = aliases && Object.hasOwn(aliases.attachments, id) ? aliases.attachments[id] : null;
  return target ? attachments.get(target) : undefined;
}
