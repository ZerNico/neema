import { randomUUID } from "node:crypto";
import { MAX_ATTACHMENT_BYTES } from "~/modules/attachments/constants.ts";
import { sha256Hex } from "~/modules/attachments/server/sha256.ts";
import { classifyFile } from "~/modules/attachments/server/validation.ts";
import type { OfficeFamily } from "~/modules/office/names.ts";
import type { WorkingFileRef } from "./file-ref.ts";

export type { WorkingFileRef } from "./file-ref.ts";

/**
 * Who may replace a file: one Office family's tools, one custom tool module,
 * or nobody for a file imported from the user's computer.
 */
export type WorkingFileOwner = OfficeFamily | "local" | `custom:${string}`;
export type KeptWorkingFileOwner = Exclude<WorkingFileOwner, "local">;

export interface WorkingFileSnapshot {
  readonly ref: WorkingFileRef;
  readonly name: string;
  readonly mediaType: string;
  /** Shared with the workspace, never copied: nobody writes into it. */
  readonly bytes: Uint8Array;
  readonly fingerprint: string;
  readonly owner: WorkingFileOwner;
  /** The pinned reference a draft was opened from, checked again before it is read or published. */
  readonly source?: string;
}

/** A file kept from an earlier answer in this chat; its bytes load on first use. */
export interface KeptWorkingFile {
  readonly ref: WorkingFileRef;
  readonly name: string;
  readonly mediaType: string;
  readonly fingerprint: string;
  readonly owner: KeptWorkingFileOwner;
  readonly source?: string;
  readonly attachmentId: string;
}

interface Entry {
  ref: WorkingFileRef;
  name: string;
  mediaType: string;
  /** Null while a kept file's bytes are still in storage. */
  bytes: Uint8Array | null;
  loading?: Promise<void>;
  fingerprint: string;
  owner: WorkingFileOwner;
  source?: string;
  kept?: KeptWorkingFile;
  state: "working" | "publishing" | "published";
  attachmentId?: string;
  /** Not yet kept at this revision, so a later answer needs it saved. */
  changed: boolean;
}

const LIMITS = {
  /** Files one answer may create; kept files it continues do not count. */
  files: 8,
  fileBytes: MAX_ATTACHMENT_BYTES,
  attemptBytes: 4 * MAX_ATTACHMENT_BYTES,
  processBytes: 256 * 1024 * 1024,
} as const;
/** Kept files a later answer is offered, newest first; older ones wait out their retention. */
export const KEPT_WORKING_FILES_OFFERED = LIMITS.files;

let processBytes = 0;

// The bytes decide the type, never the tool's declaration (docs/internals/files.md).
const contents = (file: { name: string; mediaType: string; bytes: Uint8Array }) => ({
  name: file.name,
  mediaType: classifyFile(file.name, file.mediaType, file.bytes).mediaType,
  bytes: file.bytes,
  fingerprint: sha256Hex(file.bytes),
});

/**
 * Bytes are private to one generation. Files kept from earlier answers keep
 * their identifiers and revisions; `load` fetches their bytes on first use.
 */
export const createWorkingFiles = (
  options: {
    kept?: ReadonlyArray<KeptWorkingFile>;
    load?: (file: KeptWorkingFile) => Promise<Uint8Array>;
  } = {},
) => {
  const entries = new Map<string, Entry>(
    (options.kept ?? []).map((file) => [
      file.ref.id,
      { ...file, kept: file, bytes: null, state: "working", changed: false },
    ]),
  );
  let created = 0;
  let attemptBytes = 0;
  let disposed = false;

  const alive = () => {
    if (disposed) throw new Error("This working-file attempt has ended.");
  };
  const current = (ref: WorkingFileRef) => {
    alive();
    const entry = entries.get(ref.id);
    if (!entry) throw new Error("This working file is not available in this attempt.");
    if (entry.ref.revision !== ref.revision)
      throw new Error(`Working file revision conflict: current revision is ${entry.ref.revision}.`);
    return entry;
  };
  const ensureSpace = (oldSize: number, newSize: number) => {
    if (newSize === 0 || newSize > LIMITS.fileBytes)
      throw new Error("The working file is empty or exceeds its per-file size limit.");
    if (attemptBytes - oldSize + newSize > LIMITS.attemptBytes)
      throw new Error("This attempt has reached its working-file byte limit.");
    if (processBytes - oldSize + newSize > LIMITS.processBytes)
      throw new Error("The server has reached its working-file byte limit.");
  };
  const account = (oldSize: number, newSize: number) => {
    attemptBytes += newSize - oldSize;
    processBytes += newSize - oldSize;
  };
  const snapshot = (entry: Entry): WorkingFileSnapshot => {
    if (!entry.bytes) throw new Error("This working file has not been loaded yet.");
    return {
      ref: entry.ref,
      name: entry.name,
      mediaType: entry.mediaType,
      bytes: entry.bytes,
      fingerprint: entry.fingerprint,
      owner: entry.owner,
      ...(entry.source === undefined ? {} : { source: entry.source }),
    };
  };

  return {
    /** Takes ownership of `bytes`: the caller must not write into them afterwards. */
    create(input: {
      name: string;
      mediaType: string;
      bytes: Uint8Array;
      owner: WorkingFileOwner;
      source?: string;
    }): WorkingFileSnapshot {
      alive();
      if (created >= LIMITS.files)
        throw new Error("This answer has reached its working-file count limit.");
      ensureSpace(0, input.bytes.length);
      const entry: Entry = {
        ...contents(input),
        ref: { kind: "working", id: randomUUID(), revision: 1 },
        owner: input.owner,
        ...(input.source === undefined ? {} : { source: input.source }),
        state: "working",
        changed: true,
      };
      entries.set(entry.ref.id, entry);
      created += 1;
      account(0, input.bytes.length);
      return snapshot(entry);
    },
    /** Fetches a kept file's bytes; a no-op for a file this answer already holds. */
    async load(ref: WorkingFileRef): Promise<void> {
      const entry = current(ref);
      if (entry.bytes) return;
      const { kept } = entry;
      if (!options.load || !kept) throw new Error("This working file is no longer available.");
      entry.loading ??= options.load(kept).then((bytes) => {
        ensureSpace(0, bytes.length);
        if (sha256Hex(bytes) !== entry.fingerprint)
          throw new Error("This working file no longer matches its saved revision.");
        entry.bytes = bytes;
        account(0, bytes.length);
      });
      try {
        await entry.loading;
      } finally {
        delete entry.loading;
      }
    },
    read(ref: WorkingFileRef): WorkingFileSnapshot {
      const entry = current(ref);
      if (entry.state === "published")
        throw new Error("This working file has been published. Open its attachment instead.");
      return snapshot(entry);
    },
    /** Takes ownership of `bytes`, like `create`. */
    replace(
      ref: WorkingFileRef,
      input: { bytes: Uint8Array; name: string; mediaType: string; owner: WorkingFileOwner },
    ): WorkingFileSnapshot {
      const entry = current(ref);
      if (entry.owner !== input.owner)
        throw new Error("This tool cannot replace a file owned by another editor.");
      if (entry.state !== "working") throw new Error("This working file cannot be edited now.");
      const oldSize = entry.bytes?.length ?? 0;
      ensureSpace(oldSize, input.bytes.length);
      account(oldSize, input.bytes.length);
      Object.assign(entry, contents(input));
      entry.ref = { ...ref, revision: ref.revision + 1 };
      entry.changed = true;
      return snapshot(entry);
    },
    /**
     * Seals an exact revision while its attachment is registered. One
     * publication at a time: a second request waits for no one, it is refused.
     */
    preparePublish(
      ref: WorkingFileRef,
    ):
      | { readonly state: "pending"; readonly file: WorkingFileSnapshot }
      | { readonly state: "published"; readonly attachmentId: string } {
      const entry = current(ref);
      if (entry.state === "published" && entry.attachmentId)
        return { state: "published", attachmentId: entry.attachmentId };
      if (entry.state === "publishing") throw new Error("This file is already being published.");
      const file = snapshot(entry);
      entry.state = "publishing";
      return { state: "pending", file };
    },
    /** Without an attachment the registration failed and the draft is editable again. */
    finishPublish(ref: WorkingFileRef, attachmentId?: string): void {
      const entry = current(ref);
      if (entry.state !== "publishing") throw new Error("This file is not being published.");
      if (!attachmentId) {
        entry.state = "working";
        return;
      }
      entry.state = "published";
      entry.attachmentId = attachmentId;
      account(entry.bytes?.length ?? 0, 0);
      entry.bytes = null;
      entry.changed = false;
    },
    /**
     * What a later answer should find: current revisions of unpublished drafts
     * not yet kept. Imports from the user's computer are never kept.
     */
    changes(): ReadonlyArray<WorkingFileSnapshot & { owner: KeptWorkingFileOwner }> {
      return [...entries.values()].flatMap((entry) =>
        entry.changed && entry.state === "working" && entry.owner !== "local"
          ? [{ ...snapshot(entry), owner: entry.owner }]
          : [],
      );
    },
    /** A failed save leaves the revision changed, so the next boundary retries it. */
    markKept(ref: WorkingFileRef): void {
      const entry = entries.get(ref.id);
      if (entry?.ref.revision === ref.revision) entry.changed = false;
    },
    unfinished(): ReadonlyArray<{ ref: WorkingFileRef; name: string }> {
      return [...entries.values()]
        .filter((entry) => entry.state !== "published")
        .map((entry) => ({ ref: entry.ref, name: entry.name }));
    },
    dispose(): void {
      if (disposed) return;
      processBytes -= attemptBytes;
      attemptBytes = 0;
      entries.clear();
      disposed = true;
    },
  };
};

export type WorkingFiles = ReturnType<typeof createWorkingFiles>;
