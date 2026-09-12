import { Effect } from "effect";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  desktopShellOutdated,
  makeDesktopClient,
  readDesktopChannel,
  type DesktopClient,
  type FolderStatus,
} from "@chat/desktop-rpc";

/**
 * The site's side of the desktop bridge.
 *
 * Present only inside the desktop shell, and only on the origin that shell was
 * pointed at. In an ordinary browser `readDesktopChannel` returns null and every
 * caller here is expected to render nothing rather than degrade: a folder
 * control with no machine behind it would be a promise the page cannot keep.
 */

/** The key a conversation's folder hangs on before the conversation exists. */
export const DRAFT_CONVERSATION = "__draft__";

let cached: DesktopClient | null | undefined;

/** Resolved once: the channel is injected at document start or never. */
export const desktopClient = (): DesktopClient | null => {
  if (cached === undefined) {
    const channel = readDesktopChannel();
    cached = channel === null ? null : makeDesktopClient(channel);
  }
  return cached;
};

/** Never changes: the channel is injected before any script runs, or never. */
const subscribeToNothing = () => () => {};

/** The shell's build stamp, or null outside it. Shown so a stale build is visible. */
export const desktopBuild = (): string | null => readDesktopChannel()?.build ?? null;

/** True inside a desktop app older than this site. Never true in a browser. */
export const useDesktopOutdated = (): boolean =>
  useSyncExternalStore(subscribeToNothing, desktopShellOutdated, () => false);

export const useDesktop = (): DesktopClient | null =>
  // The server has no channel and the desktop shell does, so the two snapshots
  // genuinely differ. That is what the third argument is for; reading it during
  // render instead would be a hydration mismatch.
  useSyncExternalStore(subscribeToNothing, desktopClient, () => null);

export interface FolderState {
  readonly status: FolderStatus;
  readonly busy: boolean;
  refresh: () => void;
  choose: () => void;
  detach: () => void;
  setUpSandbox: () => void;
}

const NONE: FolderStatus = { kind: "none" };

/**
 * Folder state for one conversation. Re-reads whenever the window regains
 * focus, which is what makes installing a missing dependency in a terminal and
 * switching back enough to clear the setup prompt.
 */
export const useFolder = (conversationId: string): FolderState | null => {
  const client = useDesktop();
  const [status, setStatus] = useState<FolderStatus>(NONE);
  const [busy, setBusy] = useState(false);

  const actions = useMemo(() => {
    if (!client) return null;
    const run = (effect: Effect.Effect<FolderStatus, unknown>) => {
      setBusy(true);
      void Effect.runPromise(Effect.result(effect)).then((outcome) => {
        setBusy(false);
        if (outcome._tag === "Success") setStatus(outcome.success);
      });
    };
    return {
      refresh: () => run(client.folderStatus({ conversationId })),
      choose: () => run(client.chooseFolder({ conversationId })),
      detach: () => {
        setBusy(true);
        void Effect.runPromise(Effect.result(client.detachFolder({ conversationId }))).then(() => {
          setBusy(false);
          setStatus(NONE);
        });
      },
      setUpSandbox: () =>
        run(Effect.flatMap(client.setUpSandbox(), () => client.folderStatus({ conversationId }))),
    };
  }, [client, conversationId]);

  useEffect(() => {
    if (!actions) return;
    actions.refresh();
    const onFocus = () => actions.refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [actions]);

  if (!actions) return null;
  return { status, busy, ...actions };
};

export interface DesktopSendFields {
  /** Proves the send came from the desktop app; a work chat refuses one without it. */
  readonly fromDesktop: true;
  /** Name only, when attached: the server stores no path, so another machine can differ. */
  readonly desktopFolder?: string;
  /** False while this machine cannot sandbox, which withholds run_command. */
  readonly desktopCommands: boolean;
}

/**
 * What each message reports about the machine it was sent from, or null in a
 * browser. A folder is not required: without one the desktop is still there,
 * and the folder tools are simply withheld until one is attached.
 */
export const useDesktopSendFields = (conversationId: string): DesktopSendFields | null => {
  const folder = useFolder(conversationId);
  if (!folder) return null;
  const attached = folder.status.kind === "attached" ? folder.status : null;
  return {
    fromDesktop: true,
    ...(attached ? { desktopFolder: attached.name } : {}),
    desktopCommands: attached?.sandbox.kind === "ready",
  };
};

/**
 * Carries a folder picked before the first message onto the conversation that
 * message created. A no-op in a browser, and harmless when nothing was picked.
 */
export const rebindDraftFolder = (conversationId: string): void => {
  const client = desktopClient();
  if (!client) return;
  void Effect.runPromise(
    Effect.result(
      client.rebindFolder({
        fromConversationId: DRAFT_CONVERSATION,
        toConversationId: conversationId,
      }),
    ),
  );
};
