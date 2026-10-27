import { posix } from "node:path";
import { LIMITS } from "@chat/desktop-rpc";
import { unifiedDiff } from "../diff.ts";
import { literalReplacementSize } from "../literal-replacement.ts";
import { globToRegExp, matchedPrefix } from "./glob.ts";
import type { Guest, GuestEntry } from "./hypervisor.ts";
import { place, roots, type Mount } from "./paths.ts";

/** Why a file tool did not do what was asked, in words the model can act on. */
export class Refusal extends Error {
  constructor(
    readonly reason:
      | "outside"
      | "not-found"
      | "not-a-directory"
      | "not-text"
      | "not-binary"
      | "too-large"
      | "no-match"
      | "ambiguous-match"
      | "already-exists"
      | "bad-pattern"
      | "read-only"
      | "failed",
    message: string,
  ) {
    super(message);
  }
}

const BINARY_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

/** What an import may bring in for server tools: pictures to place, Office files to edit. */
const IMPORT_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

/**
 * `--no-config` first: a config could add `--no-ignore` and read what the folder asked to have
 * skipped. `--no-require-git` makes a `.gitignore` count outside a checkout.
 */
const RG_TREE = ["--no-config", "--hidden", "--no-require-git", "--glob", "!.git"] as const;
/** Output kept from one rg run; a find past it is reported as truncated. */
const RG_OUTPUT_BYTES = 8 * 1024 * 1024;

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Runs a script with its values as $1, $2, … so nothing is ever quoted into it. */
const sh = (guest: Guest, script: string, ...args: string[]) =>
  guest.run({ argv: ["/bin/sh", "-c", script, "sh", ...args] });
const bash = (guest: Guest, script: string, ...args: string[]) =>
  guest.run({ argv: ["/bin/bash", "-c", script, "bash", ...args] });

const located = (path: string, mounts: readonly Mount[]) => {
  const placed = place(path, mounts);
  if (!placed.ok)
    throw new Refusal(
      "outside",
      placed.reason === "not-absolute"
        ? `${path} is not an absolute path. Paths start at /workspace or /folders/<name>.`
        : `${path} is outside this chat's folders. list_folder "." lists the ones it can reach.`,
    );
  return placed;
};

const writable = (path: string, mounts: readonly Mount[]) => {
  const placed = located(path, mounts);
  if (placed.readOnly)
    throw new Refusal("read-only", `${placed.root} is attached read-only, so it cannot change.`);
  return placed;
};

const isRoot = (path: string, mounts: readonly Mount[]) =>
  roots(mounts).some((root) => root.path === path);

const existing = async (guest: Guest, path: string): Promise<GuestEntry> => {
  const entry = await guest.stat(path);
  if (!entry) throw new Refusal("not-found", `${path} does not exist.`);
  return entry;
};

export async function listFolder(guest: Guest, mounts: readonly Mount[], path: string) {
  if (path === "." || path === "")
    return {
      path: ".",
      entries: roots(mounts).map((root) => ({
        name: root.readOnly ? `${root.path} (read-only)` : root.path,
        kind: "directory" as const,
      })),
      truncated: false,
    };
  const placed = located(path, mounts);
  const entry = await existing(guest, placed.path);
  if (entry.kind !== "directory")
    throw new Refusal("not-a-directory", `${placed.path} is not a directory.`);
  const found = await guest.list(placed.path);
  const kept = found.slice(0, LIMITS.entries);
  return {
    path: placed.path,
    entries: kept.map((item) => ({
      name: posix.basename(item.path),
      kind: item.kind,
      ...(item.kind === "file" ? { size: item.size } : {}),
    })),
    truncated: found.length > kept.length,
  };
}

/**
 * Lines from `offset` (counting from 1), at most `limit` of them and `LIMITS.readChars` in all.
 * Only what follows the offset is read, so a late offset in a large log never loads the start.
 */
export async function readTextFile(
  guest: Guest,
  mounts: readonly Mount[],
  path: string,
  offset = 1,
  limit = Number.POSITIVE_INFINITY,
) {
  const placed = located(path, mounts);
  const entry = await existing(guest, placed.path);
  if (entry.kind === "directory")
    throw new Refusal("not-text", `${placed.path} is a directory. list_folder lists it.`);
  const startLine = Math.max(1, offset);
  // The first line counts NUL bytes in the file's first 8 KB, which is what `file` and git
  // use to call something binary; the rest is the file from the offset on.
  const { stdout } = await sh(
    guest,
    `head -c 8000 "$1" | tr -dc '\\000' | wc -c; tail -n +"$2" "$1" | head -c "$3"`,
    placed.path,
    String(startLine),
    String(LIMITS.readBytes),
  );
  const newline = stdout.indexOf(10);
  if (Number(stdout.subarray(0, newline).toString()) > 0)
    throw new Refusal("not-text", `${placed.path} is not a text file.`);
  const body = stdout.subarray(newline + 1);
  // A cut can land inside a character; only whole ones are kept.
  const text = new TextDecoder().decode(body).replace(/�$/, "");
  const reachedEnd = body.length < LIMITS.readBytes;
  let kept = "";
  let taken = 0;
  let nextLine: number | null = null;
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  for (const [index, line] of lines.entries()) {
    const number = startLine + index;
    if (taken >= limit || kept.length >= LIMITS.readChars) {
      nextLine = number;
      break;
    }
    const piece = line.slice(0, LIMITS.readChars - kept.length);
    kept += piece;
    taken += 1;
    // One line longer than what is left is cut; the rest of it cannot be paged to.
    if (piece.length < line.length) {
      nextLine = number + 1;
      break;
    }
  }
  if (nextLine === null && !reachedEnd) nextLine = startLine + taken;
  const lineCount = nextLine === null ? startLine - 1 + lines.length : undefined;
  return {
    path: placed.path,
    text: kept,
    truncated: nextLine !== null,
    startLine,
    ...(nextLine !== null ? { nextLine } : {}),
    ...(lineCount !== undefined ? { lineCount } : {}),
  };
}

/** An image or PDF for the model to look at, or an Office file or picture to import. */
export async function readBinaryFile(
  guest: Guest,
  mounts: readonly Mount[],
  path: string,
  purpose: "view" | "import",
) {
  const placed = located(path, mounts);
  const importing = purpose === "import";
  const mediaType = (importing ? IMPORT_MEDIA_TYPES : BINARY_MEDIA_TYPES)[
    posix.extname(placed.path).toLowerCase()
  ];
  if (!mediaType)
    throw new Refusal(
      "not-binary",
      importing
        ? `${placed.path} is not a PNG, JPEG, PowerPoint (.pptx), Excel (.xlsx) or Word (.docx) file.`
        : `${placed.path} is not an image or a PDF.`,
    );
  const entry = await existing(guest, placed.path);
  if (entry.size > LIMITS.binaryBytes)
    throw new Refusal(
      "too-large",
      `${placed.path} is larger than ${LIMITS.binaryBytes / 1024 / 1024} MB.`,
    );
  const bytes = await guest.read(placed.path);
  return { path: placed.path, mediaType, bytes };
}

const readOnlyFailure = (path: string, error: unknown) =>
  /read-only|EROFS/i.test(String(error))
    ? new Refusal("read-only", `${path} is in a folder attached read-only.`)
    : new Refusal("failed", `Could not write ${path}.`);

export async function writeTextFile(
  guest: Guest,
  mounts: readonly Mount[],
  path: string,
  text: string,
) {
  if (Buffer.byteLength(text, "utf8") > LIMITS.writeBytes)
    throw new Refusal("too-large", "That file is too large to write.");
  const placed = writable(path, mounts);
  const before = await guest.stat(placed.path);
  if (before?.kind === "directory")
    throw new Refusal("already-exists", `${placed.path} is a directory.`);
  await sh(guest, `mkdir -p "$1"`, posix.dirname(placed.path));
  await guest.write(placed.path, text).catch((error: unknown) => {
    throw readOnlyFailure(placed.path, error);
  });
  return { path: placed.path, created: before === null, bytes: Buffer.byteLength(text, "utf8") };
}

/** Writes bytes the server sent, exactly at `path` or under a fresh name in a folder. */
export async function saveBytes(
  guest: Guest,
  mounts: readonly Mount[],
  target: { path: string } | { folder: string; name: string },
  bytes: Buffer,
) {
  if (bytes.length > LIMITS.binaryBytes)
    throw new Refusal(
      "too-large",
      `That file is larger than ${LIMITS.binaryBytes / 1024 / 1024} MB.`,
    );
  let path: string;
  if ("path" in target) path = writable(target.path, mounts).path;
  else {
    const folder = writable(target.folder, mounts).path;
    // Control characters never belong in a file name the model will see and pass back.
    const safe =
      [...posix.basename(target.name)].filter((char) => char.charCodeAt(0) >= 0x20).join("") ||
      "file";
    const ext = posix.extname(safe);
    const stem = safe.slice(0, safe.length - ext.length);
    path = posix.join(folder, safe);
    for (let n = 2; await guest.stat(path); n += 1)
      path = posix.join(folder, `${stem} (${n})${ext}`);
  }
  await sh(guest, `mkdir -p "$1"`, posix.dirname(path));
  await guest.write(path, bytes).catch((error: unknown) => {
    throw readOnlyFailure(path, error);
  });
  return { path, bytes: bytes.length };
}

export async function editTextFile(
  guest: Guest,
  mounts: readonly Mount[],
  input: { path: string; old: string; new: string; all?: boolean },
) {
  const placed = writable(input.path, mounts);
  const entry = await existing(guest, placed.path);
  if (entry.size > LIMITS.writeBytes)
    throw new Refusal("too-large", `${placed.path} is too large to edit.`);
  const bytes = await guest.read(placed.path);
  if (bytes.subarray(0, 8_000).includes(0))
    throw new Refusal("not-text", `${placed.path} is not a text file.`);
  let text: string;
  try {
    text = strictUtf8.decode(bytes);
  } catch {
    // Written back whole, so a byte that is not UTF-8 would come back as U+FFFD everywhere.
    throw new Refusal(
      "not-text",
      `${placed.path} is not UTF-8 text, so editing it would damage it. Rewrite it whole with write_file if that is what you mean.`,
    );
  }
  // Models write lines with \n; a file with Windows line endings keeps its own. Lines that
  // match as written win, so a stray \r\n elsewhere changes nothing.
  const crlf =
    text.includes("\r\n") &&
    !input.old.includes("\r") &&
    !input.new.includes("\r") &&
    (!input.old.includes("\n") || !text.includes(input.old));
  const before = crlf ? input.old.replaceAll("\n", "\r\n") : input.old;
  const after = crlf ? input.new.replaceAll("\n", "\r\n") : input.new;
  if (before === "") throw new Refusal("no-match", "The text to replace must not be empty.");
  // Exact, and unique unless told otherwise: a sharp refusal beats an edit landing somewhere
  // the model did not look.
  const first = text.indexOf(before);
  if (first === -1)
    throw new Refusal(
      "no-match",
      `The text to replace was not found in ${placed.path}. It must match exactly, whitespace included.`,
    );
  if (!input.all && text.indexOf(before, first + before.length) !== -1)
    throw new Refusal(
      "ambiguous-match",
      `The text to replace appears more than once in ${placed.path}. Include more surrounding lines so it is unique, or set all to replace every occurrence.`,
    );
  const projected = literalReplacementSize(text, before, after, input.all ?? false);
  if (projected.bytes > LIMITS.writeBytes)
    throw new Refusal("too-large", `${placed.path} would be too large to write.`);
  const next = input.all ? text.replaceAll(before, () => after) : text.replace(before, () => after);
  await guest.write(placed.path, next).catch((error: unknown) => {
    throw readOnlyFailure(placed.path, error);
  });
  const preview = unifiedDiff(placed.path, text, next);
  const truncated = preview.truncated || preview.diff.length > LIMITS.readChars;
  return {
    path: placed.path,
    replacements: projected.replacements,
    diff: truncated ? preview.diff.slice(0, LIMITS.readChars) : preview.diff,
    truncated,
  };
}

export async function deletePaths(
  guest: Guest,
  mounts: readonly Mount[],
  paths: readonly string[],
) {
  const deleted: { path: string; kind: "file" | "directory" }[] = [];
  const failed: { path: string; message: string }[] = [];
  // Per-path misses stay in the receipt so one missing file does not abort the rest.
  for (const path of new Set(paths)) {
    try {
      const placed = writable(path, mounts);
      if (isRoot(placed.path, mounts))
        throw new Refusal("outside", "A folder of this chat itself cannot be deleted.");
      const entry = await existing(guest, placed.path);
      const { code } = await sh(guest, `rm -rf -- "$1"`, placed.path);
      if (code !== 0) throw new Refusal("failed", `Could not delete ${placed.path}.`);
      deleted.push({ path: placed.path, kind: entry.kind === "directory" ? "directory" : "file" });
    } catch (error) {
      failed.push({ path, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { deleted, failed };
}

/** Files and folders matching a glob across every root, newest first. */
export async function findFiles(guest: Guest, mounts: readonly Mount[], pattern: string) {
  // Models write roots into patterns (`/folders/site/**/*.ts`, `/folders/**/*.md`): an absolute
  // one is matched against whole paths, in each root its fixed start can reach.
  // A folder named as the pattern (`/folders/site/`) means everything in it.
  if (pattern.length > 1 && pattern.endsWith("/")) pattern = `${pattern}**`;
  const absolute = pattern.startsWith("/");
  const fixed = absolute ? pattern.slice(0, pattern.search(/[*?{]|$/)) : "";
  const all = roots(mounts).filter(
    (root) => !absolute || `${root.path}/`.startsWith(fixed) || fixed.startsWith(`${root.path}/`),
  );
  if (all.length === 0)
    throw new Refusal(
      "outside",
      `${pattern} is outside this chat's folders. list_folder "." lists the ones it can reach.`,
    );
  let matcher: RegExp;
  try {
    matcher = globToRegExp(pattern, absolute);
  } catch {
    throw new Refusal("bad-pattern", `Could not read ${pattern}.`);
  }
  // Each root answers for itself; the cap applies to the union so a big first folder cannot
  // hide the second entirely.
  const perRoot = Math.max(1, Math.floor(LIMITS.foundPaths / all.length));
  const paths: string[] = [];
  let truncated = false;
  for (const root of all) {
    const { stdout } = await sh(
      guest,
      `cd "$1" 2>/dev/null || exit 0; shift; rg "$@" | head -c ${RG_OUTPUT_BYTES}`,
      root.path,
      "--files",
      ...RG_TREE,
      "--sortr",
      "modified",
      "--",
      ".",
    );
    const listed = stdout
      .toString()
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => (line.startsWith("./") ? line.slice(2) : line));
    truncated ||= stdout.length >= RG_OUTPUT_BYTES;
    // rg lists files only: a matching folder is named once, before the files it holds.
    const found: string[] = [];
    const folders = new Set<string>();
    for (const relative of listed) {
      const path = `${root.path}/${relative}`;
      const prefix = matchedPrefix(matcher, absolute ? path : relative);
      if (prefix === undefined) continue;
      const folder = absolute ? prefix : `${root.path}/${prefix}`;
      if (folder !== path && !folders.has(folder)) {
        folders.add(folder);
        found.push(`${folder}/`);
      }
      found.push(path);
    }
    paths.push(...found.slice(0, perRoot));
    truncated ||= found.length > perRoot;
  }
  return { pattern, paths: paths.slice(0, LIMITS.foundPaths), truncated };
}

interface RgEvent {
  readonly type: string;
  readonly data: {
    readonly path?: { readonly text?: string };
    readonly line_number?: number | null;
    readonly lines?: { readonly text?: string };
    readonly stats?: { readonly searches: number };
  };
}

/** Matching lines across every root, through rg's JSON events. */
export async function searchFiles(
  guest: Guest,
  mounts: readonly Mount[],
  pattern: string,
  glob?: string,
) {
  const matches: { path: string; line: number; text: string }[] = [];
  let filesSearched = 0;
  let truncated = false;
  for (const root of roots(mounts)) {
    if (matches.length >= LIMITS.matches) {
      truncated = true;
      break;
    }
    const { code, stdout, stderr } = await bash(
      guest,
      `cd "$1" 2>/dev/null || exit 0; shift; rg "$@" | head -c ${RG_OUTPUT_BYTES}; exit "\${PIPESTATUS[0]}"`,
      root.path,
      "--json",
      ...RG_TREE,
      "--regexp",
      pattern,
      // Per file, not in total: this keeps one file with thousands of hits from filling the
      // output budget on its own.
      "--max-count",
      String(LIMITS.matches + 1),
      ...(glob ? ["--glob", glob] : []),
      "--",
      ".",
    );
    let summarised = false;
    for (const line of stdout.toString().split("\n")) {
      if (!line) continue;
      let event: RgEvent;
      try {
        event = JSON.parse(line) as RgEvent;
      } catch {
        continue;
      }
      if (event.type === "summary") {
        filesSearched += event.data.stats?.searches ?? 0;
        summarised = true;
      } else if (event.type === "match") {
        if (matches.length >= LIMITS.matches) {
          truncated = true;
          continue;
        }
        const relative = (event.data.path?.text ?? "").replace(/^\.\//, "");
        const text = (event.data.lines?.text ?? "").replace(/\r?\n$/, "");
        matches.push({
          path: `${root.path}/${relative}`,
          line: event.data.line_number ?? 0,
          text: text.slice(0, LIMITS.matchChars),
        });
      }
    }
    const error = stderr.toString();
    if (!summarised && /regex parse error|error parsing glob|unrecognized escape/i.test(error))
      throw new Refusal("bad-pattern", `${pattern} is not a valid regular expression.`);
    if (!summarised && code === 2 && error.trim())
      throw new Refusal("failed", `The search failed: ${error.split("\n")[0]!.slice(0, 300)}`);
    truncated ||= !summarised;
  }
  return { pattern, matches, filesSearched, truncated };
}
