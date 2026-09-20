import { useCallback, useMemo, useRef, useState } from "react";
import { Effect } from "effect";
import { LIMITS, filePathForFile } from "@chat/desktop-rpc";
import {
  attachmentKind,
  formatFileSize,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "~/modules/attachments/constants.ts";
import { desktopClient } from "./bridge.ts";

/**
 * The composer chip row for work chats inside the desktop app: drops and
 * pastes are copied into the chat's local workspace instead of being uploaded
 * as server attachments. The file lands on disk the moment the chip appears
 * (import at add time), so a send never has to move bytes first.
 *
 * Mirrors the `use-attachment-uploads` state machine (same statuses, same
 * queued-submit contract) so the composer composes the two with no new
 * shapes.
 */
export interface WorkspaceImport {
  readonly localId: string;
  readonly fileName: string;
  readonly size: number;
  readonly kind: "image" | "pdf" | "text";
  readonly status: "importing" | "complete" | "error";
  /** The name the file landed under in the workspace; set once imported. */
  readonly storedName: string | null;
  readonly error: string | null;
  /**
   * The drop's path on this machine, when the shell knows one. Import copies
   * from it instead of shipping bytes; a paste has none and uses base64.
   */
  readonly sourcePath: string | null;
}

export interface WorkspaceImports {
  readonly items: ReadonlyArray<WorkspaceImport>;
  /** Names of the files a send would report as added to the workspace. */
  readonly fileNames: ReadonlyArray<string>;
  readonly importing: boolean;
  readonly hasError: boolean;
  readonly isFull: boolean;
  /** Transient message for a rejected drop (too many files, too large). */
  readonly notice: string | null;
  /** A send is waiting for the in-flight imports to settle. */
  readonly queued: boolean;
  addFiles(files: ArrayLike<File> | Iterable<File>): void;
  remove(localId: string): void;
  /**
   * Runs `send` now, or once every import settles. A failed import cancels the
   * queue instead, so the draft and the chips stay put and the user can retry.
   */
  submit(send: (fileNames: ReadonlyArray<string>) => void): void;
  cancelQueue(): void;
  /** Forgets every chip without deleting anything; the files stay in the workspace. */
  markClaimed(): void;
  /** Drops every chip, removing the files no message claimed. */
  reset(): void;
  dismissNotice(): void;
}

let counter = 0;
const nextLocalId = () => `import-${++counter}`;

const readBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read that file."));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") return reject(new Error("Could not read that file."));
      // `data:<type>;base64,<payload>`; strip the header the IPC does not want.
      const comma = result.indexOf(",");
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });

export function useWorkspaceImports(conversationId: string): WorkspaceImports {
  const [items, setItems] = useState<ReadonlyArray<WorkspaceImport>>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);

  // Mirrored in a ref: imports settle in callbacks that must see the current
  // row set without re-subscribing.
  const itemsRef = useRef<ReadonlyArray<WorkspaceImport>>(items);
  const cancelled = useRef(new Set<string>());
  const pendingSend = useRef<((fileNames: ReadonlyArray<string>) => void) | null>(null);

  const commit = useCallback((next: ReadonlyArray<WorkspaceImport>) => {
    itemsRef.current = next;
    setItems(next);
  }, []);

  const patch = useCallback(
    (localId: string, changes: Partial<WorkspaceImport>) => {
      commit(
        itemsRef.current.map((item) => (item.localId === localId ? { ...item, ...changes } : item)),
      );
    },
    [commit],
  );

  const discard = useCallback(
    (storedName: string) => {
      // Best-effort: the file is local, so a lost removal is a stray file in a
      // folder the user can open, not a leak.
      const client = desktopClient();
      if (!client) return;
      void Effect.runPromise(client.discardImport({ conversationId, name: storedName })).catch(
        () => {},
      );
    },
    [conversationId],
  );

  // Runs after anything that can empty the in-flight set. Only the last
  // import to settle sees none left, so a queued send fires exactly once.
  const drainQueue = useCallback(() => {
    const send = pendingSend.current;
    if (!send) return;
    if (itemsRef.current.some((item) => item.status === "importing")) return;
    pendingSend.current = null;
    setQueued(false);
    // A failed import cancels the send; the draft and chips stay put so the
    // user can drop the chip and try again.
    if (itemsRef.current.some((item) => item.status === "error")) return;
    send(itemsRef.current.flatMap((item) => (item.storedName ? [item.storedName] : [])));
  }, []);

  const addFiles = useCallback(
    (files: ArrayLike<File> | Iterable<File>) => {
      const client = desktopClient();
      if (!client) return;
      const incoming = Array.from(files as Iterable<File>);
      if (incoming.length === 0) return;

      const room = MAX_ATTACHMENTS_PER_MESSAGE - itemsRef.current.length;
      const accepted = incoming.slice(0, Math.max(room, 0));
      if (accepted.length < incoming.length) {
        setNotice(`You can add at most ${MAX_ATTACHMENTS_PER_MESSAGE} files per message.`);
      }
      if (accepted.length === 0) return;

      const added = accepted.map((file): WorkspaceImport => {
        // A dropped file still carries its path inside the desktop shell, and
        // the copy then happens entirely in the shell: the cap is the high
        // one. A paste has no path, so it ships as base64 and stays low.
        const sourcePath = filePathForFile(file);
        const limit = sourcePath !== null ? LIMITS.importPathBytes : LIMITS.importBytes;
        const oversized = file.size > limit;
        return {
          localId: nextLocalId(),
          fileName: file.name,
          size: file.size,
          kind: attachmentKind(file.type),
          // Oversized files never reach the shell: base64 over IPC would
          // buffer the whole thing in both processes first.
          status: oversized ? "error" : "importing",
          storedName: null,
          error: oversized ? `Too large. The limit is ${formatFileSize(limit)}.` : null,
          sourcePath,
        };
      });
      commit([...itemsRef.current, ...added]);

      added.forEach((item, index) => {
        if (item.status === "error") return;
        const file = accepted[index]!;
        const send = item.sourcePath
          ? Effect.runPromise(
              client.importFileFromPath({
                conversationId,
                fileName: file.name,
                sourcePath: item.sourcePath,
              }),
            )
          : readBase64(file).then((base64) =>
              Effect.runPromise(
                client.importFile({ conversationId, fileName: file.name, base64 }),
              ),
            );
        void send.then(
            (receipt) => {
              // Removed mid-flight: the chip is gone, so remove the file too.
              if (cancelled.current.delete(item.localId)) {
                discard(receipt.path);
                return;
              }
              patch(item.localId, { status: "complete", storedName: receipt.path });
              drainQueue();
            },
            (error: unknown) => {
              if (cancelled.current.delete(item.localId)) return;
              patch(item.localId, {
                status: "error",
                error: error instanceof Error ? error.message : "Could not add that file.",
              });
              drainQueue();
            },
          );
      });
    },
    [commit, conversationId, discard, drainQueue, patch],
  );

  const remove = useCallback(
    (localId: string) => {
      const item = itemsRef.current.find((candidate) => candidate.localId === localId);
      if (!item) return;
      if (item.status === "importing") cancelled.current.add(localId);
      // An import no message claimed yet goes back out of the workspace.
      if (item.status === "complete" && item.storedName) discard(item.storedName);
      commit(itemsRef.current.filter((candidate) => candidate.localId !== localId));
      // Dropping the last importing chip is the other way the queue unblocks.
      drainQueue();
    },
    [commit, discard, drainQueue],
  );

  const dropAll = useCallback(
    (deleteUnclaimed: boolean) => {
      for (const item of itemsRef.current) {
        if (item.status === "importing") cancelled.current.add(item.localId);
        if (deleteUnclaimed && item.status === "complete" && item.storedName) {
          discard(item.storedName);
        }
      }
      commit([]);
      pendingSend.current = null;
      setQueued(false);
      setNotice(null);
    },
    [commit, discard],
  );

  const cancelQueue = useCallback(() => {
    pendingSend.current = null;
    setQueued(false);
  }, []);

  const importing = items.some((item) => item.status === "importing");
  const hasError = items.some((item) => item.status === "error");

  const fileNames = useMemo(
    () => items.flatMap((item) => (item.storedName ? [item.storedName] : [])),
    [items],
  );

  const submit = useCallback((send: (fileNames: ReadonlyArray<string>) => void) => {
    if (itemsRef.current.some((item) => item.status === "importing")) {
      pendingSend.current = send;
      setQueued(true);
      return;
    }
    send(itemsRef.current.flatMap((item) => (item.storedName ? [item.storedName] : [])));
  }, []);

  return {
    items,
    fileNames,
    importing,
    hasError,
    isFull: items.length >= MAX_ATTACHMENTS_PER_MESSAGE,
    notice,
    queued,
    addFiles,
    remove,
    submit,
    cancelQueue,
    markClaimed: useCallback(() => dropAll(false), [dropAll]),
    reset: useCallback(() => dropAll(true), [dropAll]),
    dismissNotice: useCallback(() => setNotice(null), []),
  };
}
