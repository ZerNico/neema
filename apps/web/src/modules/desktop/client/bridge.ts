import { Effect } from "effect";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  desktopShellOutdated,
  makeDesktopClient,
  readDesktopChannel,
  type DesktopClient,
  type DesktopError,
  type FolderStatus,
} from "@chat/desktop-rpc";
import { joinFolderNames } from "../tool-schema.ts";

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
  /** Why the last choice was refused, if it was: a name already attached. */
  readonly refusal: string | null;
  refresh: () => void;
  /** Opens the picker and adds the choice beside the folders already attached. */
  choose: () => void;
  detach: (name: string) => void;
  setUpSandbox: () => void;
}

const NONE: FolderStatus = { folders: [], sandbox: { kind: "unsupported", reason: "" } };

/**
 * Folder state for one conversation. Re-reads whenever the window regains
 * focus, which is what makes installing a missing dependency in a terminal and
 * switching back enough to clear the setup prompt.
 */
export const useFolder = (conversationId: string): FolderState | null => {
  const client = useDesktop();
  const [status, setStatus] = useState<FolderStatus>(NONE);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const actions = useMemo(() => {
    if (!client) return null;
    const run = (effect: Effect.Effect<FolderStatus, DesktopError>) => {
      setBusy(true);
      setRefusal(null);
      void Effect.runPromise(Effect.result(effect)).then((outcome) => {
        setBusy(false);
        if (outcome._tag === "Success") setStatus(outcome.success);
        else if (outcome.failure.reason === "already-exists") setRefusal(outcome.failure.message);
      });
    };
    return {
      refresh: () => run(client.folderStatus({ conversationId })),
      choose: () => run(client.chooseFolder({ conversationId })),
      detach: (name: string) => run(client.detachFolder({ conversationId, name })),
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
  return { status, busy, refusal, ...actions };
};

export interface DesktopSendFields {
  /** Proves the send came from the desktop app; a work chat refuses one without it. */
  readonly fromDesktop: true;
  /** The attached folders' names, joined; the server stores no path. */
  readonly desktopFolder?: string;
  /** False while this machine cannot sandbox, which withholds run_command. */
  readonly desktopCommands: boolean;
}

/**
 * What each message reports about the machine it was sent from, or null in a
 * browser. A folder is not required: without one the desktop is still there,
 * and the folder tools are simply withheld until one is attached. A folder
 * that has gone missing is left out, since the model could not reach it.
 */
export const useDesktopSendFields = (conversationId: string): DesktopSendFields | null => {
  const folder = useFolder(conversationId);
  if (!folder) return null;
  const names = folder.status.folders.filter((item) => item.alive).map((item) => item.name);
  return {
    fromDesktop: true,
    ...(names.length > 0 ? { desktopFolder: joinFolderNames(names) } : {}),
    desktopCommands: names.length > 0 && folder.status.sandbox.kind === "ready",
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
