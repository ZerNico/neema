import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  attachmentKind,
  type AttachmentKind,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  PASTED_TEXT_FILE_NAME,
  PASTE_TEXT_CHAR_THRESHOLD,
  PASTE_TEXT_LINE_THRESHOLD,
  formatFileSize,
} from "../constants.ts";
import type { Attachment } from "../schema.ts";
import { deleteAttachment, uploadAttachment } from "../server/functions.ts";

/**
 * One chip in the composer. `localId` is stable across the upload's lifetime so
 * React keys and the cancellation set survive the status transitions.
 */
export interface AttachmentUpload {
  readonly localId: string;
  readonly fileName: string;
  readonly size: number;
  readonly kind: AttachmentKind;
  readonly status: "uploading" | "complete" | "error";
  /** Object URL (fresh upload) or `/api/files/:id` (seeded), images only. */
  readonly previewUrl: string | null;
  /** Server DTO, set once the upload completes. */
  readonly attachment: Attachment | null;
  /** Already claimed by the message being edited; removal is local only. */
  readonly existing: boolean;
  readonly error: string | null;
}

export interface AttachmentUploadsOptions {
  /** Injectable for tests; defaults to the `uploadAttachment` server function. */
  upload?: (file: File) => Promise<Attachment>;
  /** Injectable for tests; defaults to the `deleteAttachment` server function. */
  destroy?: (attachmentId: string) => Promise<unknown>;
}

export interface AttachmentUploads {
  readonly items: ReadonlyArray<AttachmentUpload>;
  /** Ordered ids of the attachments a send would claim. */
  readonly attachmentIds: ReadonlyArray<string>;
  readonly uploading: boolean;
  readonly hasError: boolean;
  readonly isFull: boolean;
  /** Transient message for a rejected drop (too many files, too large). */
  readonly notice: string | null;
  /** A send is waiting for the in-flight uploads to settle. */
  readonly queued: boolean;
  addFiles(files: ArrayLike<File> | Iterable<File>): void;
  remove(localId: string): void;
  /** Replaces the chip row with attachments already stored on a message. */
  seed(attachments: ReadonlyArray<Attachment>): void;
  /**
   * Runs `send` now, or once every upload settles. A failed upload cancels the
   * queue instead, so the draft and the chips stay put and the user can retry.
   */
  submit(send: (attachmentIds: ReadonlyArray<string>) => void): void;
  cancelQueue(): void;
  /** Forgets every chip without deleting anything (the message claimed them). */
  markClaimed(): void;
  /** Drops every chip, deleting the ones no message claimed. */
  reset(): void;
  dismissNotice(): void;
}

let counter = 0;
const nextLocalId = () => `upload-${++counter}`;

const defaultUpload = (file: File): Promise<Attachment> => {
  const body = new FormData();
  body.set("file", file);
  return uploadAttachment({ data: body });
};

const defaultDestroy = (attachmentId: string) => deleteAttachment({ data: { attachmentId } });

/** Preview source for an already-stored attachment (authenticated route). */
export const attachmentUrl = (attachmentId: string) => `/api/files/${attachmentId}`;

const seededItem = (attachment: Attachment): AttachmentUpload => ({
  localId: `existing-${attachment.id}`,
  fileName: attachment.fileName,
  size: attachment.size,
  kind: attachment.kind,
  status: "complete",
  previewUrl: attachment.kind === "image" ? attachmentUrl(attachment.id) : null,
  attachment,
  existing: true,
  error: null,
});

/** Wraps a large paste as the text attachment the composer uploads instead. */
export const createPastedTextFile = (text: string) =>
  new File([text], PASTED_TEXT_FILE_NAME, { type: "text/plain" });

/** True when a paste is big enough to become an attachment rather than draft text. */
export const shouldPasteAsFile = (text: string) =>
  text.length > PASTE_TEXT_CHAR_THRESHOLD || text.split("\n").length > PASTE_TEXT_LINE_THRESHOLD;

export function useAttachmentUploads(options: AttachmentUploadsOptions = {}): AttachmentUploads {
  const [items, setItems] = useState<ReadonlyArray<AttachmentUpload>>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);

  // The list is mirrored in a ref: uploads settle in callbacks that must see
  // the current row set (and the count limit) without re-subscribing.
  const itemsRef = useRef<ReadonlyArray<AttachmentUpload>>(items);
  const cancelled = useRef(new Set<string>());
  const objectUrls = useRef(new Set<string>());
  const pendingSend = useRef<((attachmentIds: ReadonlyArray<string>) => void) | null>(null);

  // Callers pass fresh closures every render; the callbacks below read them
  // through this ref so they can stay stable.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const commit = useCallback((next: ReadonlyArray<AttachmentUpload>) => {
    itemsRef.current = next;
    setItems(next);
  }, []);

  const patch = useCallback(
    (localId: string, changes: Partial<AttachmentUpload>) => {
      commit(
        itemsRef.current.map((item) => (item.localId === localId ? { ...item, ...changes } : item)),
      );
    },
    [commit],
  );

  const releaseUrl = useCallback((url: string | null) => {
    if (url && objectUrls.current.delete(url)) URL.revokeObjectURL(url);
  }, []);

  const destroy = useCallback((attachmentId: string) => {
    // Fire-and-forget: a failed cleanup is picked up by the orphan sweep.
    void Promise.resolve((optionsRef.current.destroy ?? defaultDestroy)(attachmentId)).catch(
      () => {},
    );
  }, []);

  // Runs after anything that can empty the in-flight set. Only the last
  // upload to settle sees none left, so a queued send fires exactly once.
  const drainQueue = useCallback(() => {
    const send = pendingSend.current;
    if (!send) return;
    if (itemsRef.current.some((item) => item.status === "uploading")) return;
    pendingSend.current = null;
    setQueued(false);
    // A failed upload cancels the send; the draft and chips stay put so the
    // user can drop the chip and try again.
    if (itemsRef.current.some((item) => item.status === "error")) return;
    send(itemsRef.current.flatMap((item) => (item.attachment ? [item.attachment.id] : [])));
  }, []);

  const addFiles = useCallback(
    (files: ArrayLike<File> | Iterable<File>) => {
      const incoming = Array.from(files as Iterable<File>);
      if (incoming.length === 0) return;

      const room = MAX_ATTACHMENTS_PER_MESSAGE - itemsRef.current.length;
      const accepted = incoming.slice(0, Math.max(room, 0));
      if (accepted.length < incoming.length) {
        setNotice(`You can attach at most ${MAX_ATTACHMENTS_PER_MESSAGE} files per message.`);
      }
      if (accepted.length === 0) return;

      const added = accepted.map((file): AttachmentUpload => {
        const localId = nextLocalId();
        const kind = attachmentKind(file.type);
        const oversized = file.size > MAX_ATTACHMENT_BYTES;
        let previewUrl: string | null = null;
        if (kind === "image" && !oversized) {
          previewUrl = URL.createObjectURL(file);
          objectUrls.current.add(previewUrl);
        }
        return {
          localId,
          fileName: file.name,
          size: file.size,
          kind,
          // Oversized files never reach the network, since the server would only
          // reject them after buffering the whole body.
          status: oversized ? "error" : "uploading",
          previewUrl,
          attachment: null,
          existing: false,
          error: oversized
            ? `Too large. The limit is ${formatFileSize(MAX_ATTACHMENT_BYTES)}.`
            : null,
        };
      });
      commit([...itemsRef.current, ...added]);

      added.forEach((item, index) => {
        if (item.status === "error") return;
        const file = accepted[index]!;
        void (optionsRef.current.upload ?? defaultUpload)(file).then(
          (attachment) => {
            // Removed mid-flight: the row is already gone from the list, so
            // the only thing left to do is release the server-side upload.
            if (cancelled.current.delete(item.localId)) {
              destroy(attachment.id);
              return;
            }
            patch(item.localId, { status: "complete", attachment });
            drainQueue();
          },
          (error: unknown) => {
            if (cancelled.current.delete(item.localId)) return;
            patch(item.localId, {
              status: "error",
              error: error instanceof Error ? error.message : "Upload failed.",
            });
            drainQueue();
          },
        );
      });
    },
    [commit, destroy, drainQueue, patch],
  );

  const remove = useCallback(
    (localId: string) => {
      const item = itemsRef.current.find((candidate) => candidate.localId === localId);
      if (!item) return;
      if (item.status === "uploading") cancelled.current.add(localId);
      // An existing attachment is claimed by the message being edited; the save
      // releases it by omitting it from the replacement set.
      if (item.status === "complete" && item.attachment && !item.existing) {
        destroy(item.attachment.id);
      }
      releaseUrl(item.previewUrl);
      commit(itemsRef.current.filter((candidate) => candidate.localId !== localId));
      // Dropping the last uploading chip is the other way the queue unblocks.
      drainQueue();
    },
    [commit, destroy, drainQueue, releaseUrl],
  );

  const dropAll = useCallback(
    (deleteUnclaimed: boolean) => {
      for (const item of itemsRef.current) {
        if (item.status === "uploading") cancelled.current.add(item.localId);
        if (deleteUnclaimed && item.status === "complete" && item.attachment && !item.existing) {
          destroy(item.attachment.id);
        }
        releaseUrl(item.previewUrl);
      }
      commit([]);
      pendingSend.current = null;
      setQueued(false);
      setNotice(null);
    },
    [commit, destroy, releaseUrl],
  );

  const seed = useCallback(
    (attachments: ReadonlyArray<Attachment>) => {
      dropAll(true);
      commit(attachments.map(seededItem));
    },
    [commit, dropAll],
  );

  const cancelQueue = useCallback(() => {
    pendingSend.current = null;
    setQueued(false);
  }, []);

  const uploading = items.some((item) => item.status === "uploading");
  const hasError = items.some((item) => item.status === "error");

  const attachmentIds = useMemo(
    () => items.flatMap((item) => (item.attachment ? [item.attachment.id] : [])),
    [items],
  );

  const submit = useCallback((send: (attachmentIds: ReadonlyArray<string>) => void) => {
    if (itemsRef.current.some((item) => item.status === "uploading")) {
      pendingSend.current = send;
      setQueued(true);
      return;
    }
    send(itemsRef.current.flatMap((item) => (item.attachment ? [item.attachment.id] : [])));
  }, []);

  // Unmount: object URLs would otherwise be retained for the page's lifetime.
  // Uploads in flight are left alone; the orphan sweep collects them.
  useEffect(
    () => () => {
      for (const url of objectUrls.current) URL.revokeObjectURL(url);
      objectUrls.current.clear();
    },
    [],
  );

  return {
    items,
    attachmentIds,
    uploading,
    hasError,
    isFull: items.length >= MAX_ATTACHMENTS_PER_MESSAGE,
    notice,
    queued,
    addFiles,
    remove,
    seed,
    submit,
    cancelQueue,
    markClaimed: useCallback(() => dropAll(false), [dropAll]),
    reset: useCallback(() => dropAll(true), [dropAll]),
    dismissNotice: useCallback(() => setNotice(null), []),
  };
}
