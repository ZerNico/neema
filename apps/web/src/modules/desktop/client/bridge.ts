import { Effect } from "effect";
import type { DesktopSubmission } from "~/modules/chat/schema.ts";
import { useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  desktopShellOutdated,
  makeDesktopClient,
  readDesktopAuth,
  readDesktopBrowser,
  readDesktopChannel,
  type DesktopAuth,
  type DesktopClient,
} from "@chat/desktop-rpc";

/**
 * The site's side of the desktop bridge.
 *
 * Present only inside the desktop shell, and only on the origin that shell was
 * pointed at. In an ordinary browser `readDesktopChannel` returns null and every
 * caller here is expected to render nothing rather than degrade.
 */

let cached: DesktopClient | null | undefined;

/** Resolved once: the channel is injected at document start or never. */
export const desktopClient = (): DesktopClient | null => {
  if (typeof window === "undefined") return null;
  if (cached === undefined) {
    const channel = readDesktopChannel();
    cached = channel === null ? null : makeDesktopClient(channel);
  }
  return cached;
};

/** Never changes: the channel is injected before any script runs, or never. */
const subscribeToNothing = () => () => {};

/** True inside a desktop app older than this site. Never true in a browser. */
export const useDesktopOutdated = (): boolean =>
  useSyncExternalStore(subscribeToNothing, desktopShellOutdated, () => false);

/** The sign-in capability of the shell around this page, or null in a browser. */
export const useDesktopAuth = (): DesktopAuth | null =>
  useSyncExternalStore(subscribeToNothing, readDesktopAuth, () => null);

export const useDesktop = (): DesktopClient | null =>
  // The server has no channel and the desktop shell does, so the two snapshots
  // genuinely differ. That is what the third argument is for; reading it during
  // render instead would be a hydration mismatch.
  useSyncExternalStore(subscribeToNothing, desktopClient, () => null);

/**
 * What a submission from the desktop app adds: the app's executor, which runs the answer's
 * browser calls, and its machine, offered first when the chat has no computer yet. Empty in a
 * browser.
 */
export const desktopAttemptFields = async (): Promise<{ desktop?: DesktopSubmission }> => {
  const client = desktopClient();
  if (!client) return {};
  const session = await Effect.runPromise(client.executionSession(undefined));
  return {
    desktop: {
      executorId: session.id,
      machineId: session.machineId,
      // A shell that can show pages but not drive them gets no browser tools.
      browser: readDesktopBrowser()?.agent !== undefined,
    },
  };
};

/**
 * This machine's stable id, or null in a browser. One query for the whole
 * session: the id is fixed at shell first-run. A local path in an answer
 * resolves only on the chat's own machine.
 */
export const useLocalMachineId = (): string | null => {
  const client = useDesktop();
  const query = useQuery({
    queryKey: ["desktop-machine"],
    enabled: client !== null,
    queryFn: () => Effect.runPromise(client!.executionSession(undefined)),
    staleTime: Infinity,
    retry: false,
  });
  return query.data?.machineId ?? null;
};
