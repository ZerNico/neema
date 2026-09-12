import { Effect } from "effect";
import { useSyncExternalStore } from "react";
import {
  CancelledError,
  isCancelledError,
  queryOptions,
  QueryObserver,
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
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

export const useDesktop = (): DesktopClient | null =>
  // The server has no channel and the desktop shell does, so the two snapshots
  // genuinely differ. That is what the third argument is for; reading it during
  // render instead would be a hydration mismatch.
  useSyncExternalStore(subscribeToNothing, desktopClient, () => null);

export type FolderState = (
  | { readonly readiness: "ready"; readonly status: FolderStatus }
  | { readonly readiness: "loading" | "error"; readonly status: null }
) & {
  readonly busy: boolean;
  /** Why the last folder change failed, if it did. */
  readonly refusal: string | null;
  refresh: () => void;
  /** Opens the picker and adds the choice beside the folders already attached. */
  choose: () => void;
  detach: (name: string) => void;
  setUpSandbox: () => void;
};

export const folderQueryKey = (conversationId: string) =>
  ["desktop-folder", conversationId] as const;

export const folderQueryOptions = (conversationId: string) =>
  queryOptions({
    queryKey: folderQueryKey(conversationId),
    queryFn: ({ signal }) =>
      Effect.runPromise(desktopClient()!.folderStatus({ conversationId }), { signal }),
    staleTime: Infinity,
    retry: false,
  });

/** Keep the route pending until local state settles, without making IPC errors route errors. */
export const prepareWorkFolder = async (
  queryClient: QueryClient,
  conversationId: string,
  signal: AbortSignal,
): Promise<void> => {
  if (!desktopClient()) return;
  signal.throwIfAborted();
  const options = folderQueryOptions(conversationId);
  const cache = queryClient.getQueryCache();
  // A pending route can unmount the last useFolder while this loader still needs its read.
  // Keep an observer until preparation settles; explicit cancellation still wins.
  const observer = new QueryObserver(queryClient, { ...options, enabled: false });
  const release = observer.subscribe(() => {});
  const owner = observer.getCurrentQuery();
  const controller = new AbortController();
  const cancel = () => controller.abort(new CancelledError());
  const unsubscribe = cache.subscribe((event) => {
    if (event.type === "removed" && event.query === owner) cancel();
  });
  signal.addEventListener("abort", cancel, { once: true });
  const wait = <A>(promise: Promise<A>): Promise<A> =>
    new Promise((resolve, reject) => {
      const aborted = () => {
        controller.signal.removeEventListener("abort", aborted);
        reject(controller.signal.reason);
      };
      if (controller.signal.aborted) return aborted();
      controller.signal.addEventListener("abort", aborted, { once: true });
      void promise.then(resolve, reject).finally(() => {
        controller.signal.removeEventListener("abort", aborted);
      });
    });
  const busy = () => queryClient.isMutating({ mutationKey: options.queryKey }) > 0;
  try {
    for (;;) {
      if (busy()) {
        await new Promise<void>((resolve, reject) => {
          const finish = () => {
            stop();
            controller.signal.removeEventListener("abort", aborted);
          };
          const aborted = () => {
            finish();
            reject(controller.signal.reason);
          };
          const stop = queryClient.getMutationCache().subscribe(() => {
            if (!busy()) {
              finish();
              resolve();
            }
          });
          controller.signal.addEventListener("abort", aborted, { once: true });
          if (controller.signal.aborted) aborted();
        });
      }
      await wait(waitForDraftBinding());
      controller.signal.throwIfAborted();
      if (busy()) continue;
      const binding = draftBinding;
      const prepared = queryClient.prefetchQuery({ ...options, staleTime: 0 });
      try {
        // Prefetch swallows cancellation as well as IPC failures; only the latter can render.
        await wait(Promise.all([prepared, owner.promise]));
      } catch (error) {
        controller.signal.throwIfAborted();
        if (isCancelledError(error)) {
          if (busy() || binding !== draftBinding) continue;
          throw error;
        }
      }
      controller.signal.throwIfAborted();
      if (busy() || binding !== draftBinding) continue;
      return;
    }
  } finally {
    unsubscribe();
    release();
    signal.removeEventListener("abort", cancel);
  }
};

/** Focus refresh uses React Query's existing listener, never a polling loop. */
export const useFolder = (conversationId: string): FolderState | null => {
  const client = useDesktop();
  const queryClient = useQueryClient();
  const queryKey = folderQueryKey(conversationId);
  const busy = useIsMutating({ mutationKey: queryKey }) > 0;
  const query = useQuery({
    ...folderQueryOptions(conversationId),
    enabled: client !== null && !busy,
    refetchOnMount: false,
    retryOnMount: false,
    refetchOnWindowFocus: "always",
  });
  const mutation = useMutation({
    mutationKey: queryKey,
    scope: { id: queryKey.join(":") },
    mutationFn: async (input: {
      conversationId: string;
      effect: Effect.Effect<FolderStatus, DesktopError>;
    }) => {
      const key = folderQueryKey(input.conversationId);
      const owner = queryClient.getQueryCache().find({ queryKey: key, exact: true });
      await queryClient.cancelQueries({ queryKey: key, exact: true });
      const outcome = await Effect.runPromise(Effect.result(input.effect));
      // IdentityBoundary clears this cache. An old IPC completion must not recreate it.
      if (owner && queryClient.getQueryCache().find({ queryKey: key, exact: true }) === owner) {
        await queryClient.cancelQueries({ queryKey: key, exact: true });
        if (
          outcome._tag === "Success" &&
          queryClient.getQueryCache().find({ queryKey: key, exact: true }) === owner
        )
          queryClient.setQueryData(key, outcome.success);
      }
      if (outcome._tag === "Failure") throw outcome.failure;
    },
  });
  if (!client) return null;
  const run = (effect: Effect.Effect<FolderStatus, DesktopError>) =>
    mutation.mutate({ conversationId, effect });
  return {
    ...(query.isError
      ? { readiness: "error" as const, status: null }
      : query.data
        ? { readiness: "ready" as const, status: query.data }
        : { readiness: "loading" as const, status: null }),
    busy,
    refusal:
      mutation.variables?.conversationId === conversationId
        ? (mutation.error?.message ?? null)
        : null,
    refresh: () => {
      if (!busy) void query.refetch();
    },
    choose: () => run(client.chooseFolder({ conversationId })),
    detach: (name) => run(client.detachFolder({ conversationId, name })),
    setUpSandbox: () =>
      run(Effect.flatMap(client.setUpSandbox(), () => client.folderStatus({ conversationId }))),
  };
};

export interface DesktopSendFields {
  /** Submission policy information, not cryptographic proof of a desktop client. */
  readonly fromDesktop: true;
  /** The attached folders' names, joined; the server stores no path. */
  readonly desktopFolder?: string;
  /** False while this machine cannot sandbox, which withholds run_command. */
  readonly desktopCommands: boolean;
}

/**
 * What each message reports about the machine it was sent from, derived from
 * the one `useFolder` the view owns, or null in a browser. One owner matters:
 * the strip that attaches a folder and the send that reports it must read the
 * same state, or a send right after attaching goes out without the folder.
 * A folder that has gone missing is left out, since the model could not reach it.
 */
export const desktopSendFields = (folder: FolderState | null): DesktopSendFields | null => {
  if (!folder || folder.readiness !== "ready" || folder.busy) return null;
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
export const rebindDraftFolder = async (conversationId: string): Promise<void> => {
  const client = desktopClient();
  if (!client) return;
  await Effect.runPromise(
    client.rebindFolder({
      fromConversationId: DRAFT_CONVERSATION,
      toConversationId: conversationId,
    }),
  );
};

export const requireWorkFolder = (working: boolean, folder: FolderState | null) => {
  const fields = working ? desktopSendFields(folder) : null;
  if (working && !fields)
    throw new Error("Wait for the folder check before continuing this work chat.");
  return fields;
};

export const desktopAttemptFields = async (fields: DesktopSendFields | null) => {
  const client = desktopClient();
  if (!fields || !client) return {};
  const session = await Effect.runPromise(client.executionSession(undefined));
  return { ...fields, desktopExecutorId: session.id };
};

let draftBinding = Promise.resolve();
export const waitForDraftBinding = async () => {
  let current;
  do {
    current = draftBinding;
    await current;
  } while (current !== draftBinding);
};

// The server can publish a local call before the create-turn response arrives.
// Hold dispatch until its draft grant has the durable conversation id.
export const withDraftFolderBinding = async <A extends { conversationId: string }>(
  send: () => Promise<A>,
  queryClient: QueryClient,
): Promise<A> => {
  const previous = draftBinding;
  let release!: () => void;
  draftBinding = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await previous;
    const result = await send();
    const keys = [folderQueryKey(DRAFT_CONVERSATION), folderQueryKey(result.conversationId)];
    await Promise.all(keys.map((queryKey) => queryClient.cancelQueries({ queryKey, exact: true })));
    try {
      await rebindDraftFolder(result.conversationId);
    } finally {
      await Promise.all(
        keys.map((queryKey) => queryClient.invalidateQueries({ queryKey, exact: true })),
      );
    }
    return result;
  } finally {
    release();
  }
};
