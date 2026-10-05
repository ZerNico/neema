import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Effect } from "effect";
import { LIMITS, stageDroppedFile, type PromotionReceipt } from "@chat/desktop-rpc";
import {
  attachmentKindForFileName,
  formatFileSize,
  type AttachmentKind,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "~/modules/attachments/constants.ts";
import { readBase64 } from "~/modules/attachments/client/read-base64.ts";
import { desktopClient } from "./bridge.ts";

/** One composer file held outside the model-visible workspace until send. */
export interface WorkspaceImport {
  readonly localId: string;
  readonly fileName: string;
  readonly size: number;
  readonly kind: AttachmentKind;
  readonly status: "importing" | "complete" | "error";
  readonly storedName: string | null;
  readonly error: string | null;
}

export interface WorkspaceImports {
  readonly items: ReadonlyArray<WorkspaceImport>;
  readonly fileNames: ReadonlyArray<string>;
  readonly importing: boolean;
  readonly hasError: boolean;
  readonly isFull: boolean;
  readonly notice: string | null;
  readonly queued: boolean;
  readonly submissionId: string;
  addFiles(files: ArrayLike<File> | Iterable<File>): void;
  remove(localId: string): void;
  submit(send: (fileNames: ReadonlyArray<string>) => void): void;
  cancelQueue(): void;
  promote(reservationId: string): Promise<PromotionReceipt>;
  commit(reservationId: string): Promise<void>;
  rollback(reservationId: string): Promise<void>;
  markClaimed(): void;
  reset(): void;
  dismissNotice(): void;
}

let counter = 0;
const nextLocalId = () => `import-${++counter}`;

export function useWorkspaceImports(conversationId: string): WorkspaceImports {
  const [items, setItems] = useState<ReadonlyArray<WorkspaceImport>>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);
  const [submissionId, setSubmissionId] = useState(() => crypto.randomUUID());
  const itemsRef = useRef<ReadonlyArray<WorkspaceImport>>(items);
  const cancelled = useRef(new Set<string>());
  const pendingSend = useRef<((fileNames: ReadonlyArray<string>) => void) | null>(null);
  const promoted = useRef(false);

  const commitItems = useCallback((next: ReadonlyArray<WorkspaceImport>) => {
    itemsRef.current = next;
    setItems(next);
  }, []);

  const patch = useCallback(
    (localId: string, changes: Partial<WorkspaceImport>) => {
      commitItems(
        itemsRef.current.map((item) => (item.localId === localId ? { ...item, ...changes } : item)),
      );
    },
    [commitItems],
  );

  const discardFile = useCallback(
    (ownedSubmissionId: string, storedName: string) => {
      const client = desktopClient();
      if (!client) return;
      void Effect.runPromise(
        client.discardStagedFile({
          conversationId,
          submissionId: ownedSubmissionId,
          name: storedName,
        }),
      ).catch(() => {});
    },
    [conversationId],
  );

  const discardSubmission = useCallback(
    (ownedSubmissionId: string) => {
      const client = desktopClient();
      if (!client) return;
      void Effect.runPromise(
        client.discardSubmission({ conversationId, submissionId: ownedSubmissionId }),
      ).catch(() => {});
    },
    [conversationId],
  );

  useEffect(() => {
    const ownedSubmissionId = submissionId;
    return () => {
      for (const item of itemsRef.current)
        // oxlint-disable-next-line react-hooks/exhaustive-deps -- one Set for the hook's life, read as it is at unmount
        if (item.status === "importing") cancelled.current.add(item.localId);
      if (!promoted.current) discardSubmission(ownedSubmissionId);
    };
  }, [discardSubmission, submissionId]);

  const drainQueue = useCallback(() => {
    const send = pendingSend.current;
    if (!send || itemsRef.current.some((item) => item.status === "importing")) return;
    pendingSend.current = null;
    setQueued(false);
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
      if (accepted.length < incoming.length)
        setNotice(`You can add at most ${MAX_ATTACHMENTS_PER_MESSAGE} files per message.`);
      if (accepted.length === 0) return;

      const ownedSubmissionId = submissionId;
      const added = accepted.map((file): WorkspaceImport => {
        const oversized = file.size > LIMITS.importPathBytes;
        return {
          localId: nextLocalId(),
          fileName: file.name,
          size: file.size,
          kind: attachmentKindForFileName(file.name),
          status: oversized ? "error" : "importing",
          storedName: null,
          error: oversized
            ? `Too large. The limit is ${formatFileSize(LIMITS.importPathBytes)}.`
            : null,
        };
      });
      commitItems([...itemsRef.current, ...added]);

      added.forEach((item, index) => {
        if (item.status === "error") return;
        const file = accepted[index]!;
        const stage = Effect.runPromise(
          stageDroppedFile(file, {
            conversationId,
            submissionId: ownedSubmissionId,
            fileName: file.name,
          }),
        ).then(async (receipt) => {
          if (receipt) return receipt;
          if (file.size > LIMITS.importBytes)
            throw new Error(`Too large. The limit is ${formatFileSize(LIMITS.importBytes)}.`);
          return Effect.runPromise(
            client.stageFile({
              conversationId,
              submissionId: ownedSubmissionId,
              fileName: file.name,
              base64: await readBase64(file),
            }),
          );
        });
        void stage.then(
          (receipt) => {
            if (cancelled.current.delete(item.localId)) {
              discardFile(ownedSubmissionId, receipt.name);
              return;
            }
            patch(item.localId, { status: "complete", storedName: receipt.name });
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
    [commitItems, conversationId, discardFile, drainQueue, patch, submissionId],
  );

  const remove = useCallback(
    (localId: string) => {
      const item = itemsRef.current.find((candidate) => candidate.localId === localId);
      if (!item) return;
      if (item.status === "importing") cancelled.current.add(localId);
      if (item.status === "complete" && item.storedName) discardFile(submissionId, item.storedName);
      commitItems(itemsRef.current.filter((candidate) => candidate.localId !== localId));
      drainQueue();
    },
    [commitItems, discardFile, drainQueue, submissionId],
  );

  const reset = useCallback(() => {
    for (const item of itemsRef.current)
      if (item.status === "importing") cancelled.current.add(item.localId);
    discardSubmission(submissionId);
    commitItems([]);
    pendingSend.current = null;
    setQueued(false);
    setNotice(null);
    promoted.current = false;
    setSubmissionId(crypto.randomUUID());
  }, [commitItems, discardSubmission, submissionId]);

  const fileNames = useMemo(
    () => items.flatMap((item) => (item.storedName ? [item.storedName] : [])),
    [items],
  );

  return {
    items,
    fileNames,
    importing: items.some((item) => item.status === "importing"),
    hasError: items.some((item) => item.status === "error"),
    isFull: items.length >= MAX_ATTACHMENTS_PER_MESSAGE,
    notice,
    queued,
    submissionId,
    addFiles,
    remove,
    submit: useCallback((send: (fileNames: ReadonlyArray<string>) => void) => {
      if (itemsRef.current.some((item) => item.status === "importing")) {
        pendingSend.current = send;
        setQueued(true);
        return;
      }
      send(itemsRef.current.flatMap((item) => (item.storedName ? [item.storedName] : [])));
    }, []),
    cancelQueue: useCallback(() => {
      pendingSend.current = null;
      setQueued(false);
    }, []),
    promote: useCallback(
      async (reservationId: string) => {
        const client = desktopClient();
        if (!client) throw new Error("The desktop workspace is unavailable.");
        const receipt = await Effect.runPromise(
          client.promoteSubmission({ conversationId, submissionId, reservationId }),
        );
        promoted.current = true;
        return receipt;
      },
      [conversationId, submissionId],
    ),
    commit: useCallback(
      async (reservationId: string) => {
        const client = desktopClient();
        if (!client) return;
        await Effect.runPromise(client.commitPromotion({ conversationId, reservationId }));
      },
      [conversationId],
    ),
    rollback: useCallback(
      async (reservationId: string) => {
        const client = desktopClient();
        if (!client) return;
        await Effect.runPromise(client.rollbackPromotion({ conversationId, reservationId }));
        promoted.current = false;
      },
      [conversationId],
    ),
    markClaimed: useCallback(() => {
      commitItems([]);
      pendingSend.current = null;
      setQueued(false);
      setNotice(null);
      promoted.current = false;
      setSubmissionId(crypto.randomUUID());
    }, [commitItems]),
    reset,
    dismissNotice: useCallback(() => setNotice(null), []),
  };
}
