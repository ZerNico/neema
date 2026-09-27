import type { Attachment } from "~/modules/attachments/schema.ts";
import type { FileReferenceAliases } from "./file-reference-aliases.ts";

export const attachmentReferenceUrl = (id: string) => `/api/files/${encodeURIComponent(id)}`;

export const attachmentReferenceHint = (file: { id: string; fileName: string }) =>
  `File reference: ${JSON.stringify(file.fileName)}, attachment id ${JSON.stringify(file.id)}, link ${attachmentReferenceUrl(file.id)}.`;

export const fileReferencesSystemHint =
  "When referring to an available uploaded or tool-returned file, use a Markdown link [filename](/api/files/ATTACHMENT_ID) with its actual attachment id so the reader can preview it. Use the current file metadata, not ids copied from older answers. Never invent an id or identify a file by its name alone.";

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

export function resolveLocalReference(input: {
  path: string;
  conversationId: string;
  workspaceRoot: string | null;
  workspaceAncestors: readonly string[];
  machineId: string | null;
  originMachineId: string | null;
}): string | null {
  if (!input.machineId || input.machineId !== input.originMachineId) return null;
  const path = absoluteFilePath(input.path);
  if (!path) return null;
  const workspace = input.workspaceRoot && absoluteFilePath(input.workspaceRoot);
  // Wait for the current workspace before resolving an inherited path.
  if (!workspace || workspace.windows !== path.windows) return null;
  const cut = workspace.normalized.lastIndexOf("/");
  // Workspaces are siblings keyed by conversation id (desktop/workspaces.ts).
  if (workspace.normalized.slice(cut + 1) !== input.conversationId) return null;
  const base = workspace.normalized.slice(0, cut + 1);
  for (const ancestor of input.workspaceAncestors) {
    if (!/^[a-zA-Z0-9_-]+$/.test(ancestor)) continue;
    const source = `${base}${ancestor}/`;
    const matches = path.windows
      ? path.normalized.toLowerCase().startsWith(source.toLowerCase())
      : path.normalized.startsWith(source);
    if (matches) return `${workspace.normalized}/${path.normalized.slice(source.length)}`;
  }
  return input.path;
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
