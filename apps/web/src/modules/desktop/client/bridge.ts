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
  readDesktopAuth,
  readDesktopBrowser,
  readDesktopChannel,
  WORKSPACE_FOLDER_NAME,
  type ChatPermission,
  type ChatPermissions,
  type DesktopAuth,
  type DesktopClient,
  type DesktopError,
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

export type FolderState = (
  | { readonly readiness: "ready"; readonly status: FolderStatus }
  | { readonly readiness: "loading" | "error"; readonly status: null }
) & {
  readonly busy: boolean;
  /** Why the last folder change failed, if it did. */
  readonly refusal: string | null;
  refresh: () => void;
  /** Opens the picker and adds the choice, or replaces a named folder. */
  choose: (replace?: string) => void;
  detach: (name: string) => void;
  setUpSandbox: () => void;
  /** What this chat's commands may reach beyond the defaults, and how to remove one. */
  access: ChatAccess;
};

export interface ChatAccess {
  readonly queryKey: readonly string[];
  load: () => Promise<ChatPermissions>;
  revoke: (permission: ChatPermission) => Promise<void>;
}

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
      controller.signal.throwIfAborted();
      if (busy()) continue;
      const prepared = queryClient.prefetchQuery({ ...options, staleTime: 0 });
      try {
        // Prefetch swallows cancellation as well as IPC failures; only the latter can render.
        await wait(Promise.all([prepared, owner.promise]));
      } catch (error) {
        controller.signal.throwIfAborted();
        if (isCancelledError(error)) {
          if (busy()) continue;
          throw error;
        }
      }
      controller.signal.throwIfAborted();
      if (busy()) continue;
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
  // Prefer the last successful status: a focus refetch can fail while the
  // grants are still sitting in the cache, and treating that as empty blocks send.
  return {
    ...(query.data
      ? { readiness: "ready" as const, status: query.data }
      : query.isError
        ? { readiness: "error" as const, status: null }
        : { readiness: "loading" as const, status: null }),
    busy,
    refusal:
      mutation.variables?.conversationId === conversationId
        ? (mutation.error?.message ?? null)
        : null,
    refresh: () => {
      if (!busy) void query.refetch();
    },
    choose: (replace) =>
      run(
        client.chooseFolder({
          conversationId,
          ...(typeof replace === "string" ? { replace } : {}),
        }),
      ),
    detach: (name) => run(client.detachFolder({ conversationId, name })),
    setUpSandbox: () =>
      run(Effect.flatMap(client.setUpSandbox(), () => client.folderStatus({ conversationId }))),
    access: {
      queryKey: ["desktop-chat-permissions", conversationId],
      load: () => Effect.runPromise(client.chatPermissions({ conversationId })),
      revoke: (permission) =>
        Effect.runPromise(client.revokeChatPermission({ conversationId, permission })),
    },
  };
};

export interface DesktopSendFields {
  /** Submission policy information, not cryptographic proof of a desktop client. */
  readonly fromDesktop: true;
  /**
   * The folders this chat can reach, by name and real path. The path is the
   * model's address for everything inside and crosses as attempt-scoped prompt
   * text; the server persists the names alone.
   */
  readonly desktopFolders?: ReadonlyArray<{ name: string; path: string }>;
  /** False while this machine cannot sandbox, which withholds run_command. */
  readonly desktopCommands: boolean;
  /** Whether this app can drive embedded pages, which offers the browser tools. */
  readonly desktopBrowser: boolean;
}

/**
 * Whether a work chat may act right now: the machine answered about its
 * folders and is not changing them. The one definition the gate, the
 * composer and the send fields all read.
 */
export const folderUsable = (
  folder: FolderState | null,
): folder is Extract<FolderState, { readiness: "ready" }> =>
  folder !== null && folder.readiness === "ready" && !folder.busy;

/**
 * What each message reports about the machine it was sent from, derived from
 * the one `useFolder` the view owns, or null in a browser. One owner matters:
 * the strip that attaches a folder and the send that reports it must read the
 * same state, or a send right after attaching goes out without the folder.
 * A folder that has gone missing is left out, since the model could not reach it.
 */
export const desktopSendFields = (folder: FolderState | null): DesktopSendFields | null =>
  folderUsable(folder) ? sendFieldsFor(folder.status) : null;

/**
 * The same report from a bare status, for a chat that is not on screen: the
 * work host starts queued Work in conversations nobody has open.
 */
export const sendFieldsFor = (status: FolderStatus): DesktopSendFields => {
  const attached = status.folders
    .filter((item) => item.alive)
    .map((item) => ({ name: item.name, path: item.path }));
  // The workspace travels with its real path: it is the model's cwd and the
  // root every absolute path in the workspace falls under.
  const folders = [{ name: WORKSPACE_FOLDER_NAME, path: status.workspace.path }, ...attached];
  return {
    fromDesktop: true,
    desktopFolders: folders,
    desktopCommands: status.sandbox.kind === "ready",
    // A shell that can show pages but not drive them gets no browser tools.
    desktopBrowser: readDesktopBrowser()?.agent !== undefined,
  };
};

/** Shown when a work chat tries to act before the machine has answered about folders. */
export const WORK_FOLDER_UNAVAILABLE =
  "Wait for the folder check before continuing this work chat.";

/**
 * How a branch keeps the source chat's local state on this machine: the
 * user-attached folder grants are copied over, then the workspace directory is
 * copied. Both are awaited before the view navigates, so the destination's
 * first send cannot race its own lazy workspace creation against the copy.
 * Either failure throws; the caller toasts and navigates anyway.
 */
export const copyWorkspaceToBranch = async (
  fromConversationId: string,
  toConversationId: string,
): Promise<void> => {
  const client = desktopClient();
  if (!client) return;
  await Effect.runPromise(client.copyFolderGrants({ fromConversationId, toConversationId }));
  await Effect.runPromise(client.cloneWorkspace({ fromConversationId, toConversationId }));
};

/**
 * Best-effort removal of a deleted conversation's workspace. A failure is a
 * stray local directory, nothing the server waits for.
 */
export const discardWorkspace = (conversationId: string): void => {
  const client = desktopClient();
  if (!client) return;
  void Effect.runPromise(client.discardWorkspace({ conversationId })).catch(() => {});
};

export const requireWorkFolder = (working: boolean, folder: FolderState | null) => {
  const fields = working ? desktopSendFields(folder) : null;
  if (working && !fields) throw new Error(WORK_FOLDER_UNAVAILABLE);
  return fields;
};

export const desktopAttemptFields = async (fields: DesktopSendFields | null) => {
  const client = desktopClient();
  if (!fields || !client) return {};
  const session = await Effect.runPromise(client.executionSession(undefined));
  return {
    ...fields,
    desktopExecutorId: session.id,
    // Which machine sent this attempt. The site stamps it onto the generation
    // so another machine opening the chat later can say where the files are.
    desktopMachineId: session.machineId,
    desktopMachineName: session.machineName,
  };
};

/**
 * This machine's stable id, or null in a browser. One query for the whole
 * session: the id is fixed at shell first-run. The foreign-machine banner
 * compares the conversation's latest stamp against it.
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
