import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { toast } from "sonner";
import { DesktopError, type FolderStatus } from "@chat/desktop-rpc";
import { useDesktop, useLocalMachineId } from "~/modules/desktop/client/bridge.ts";
import { capabilitiesQuery } from "~/modules/groups/client/queries.ts";
import { m } from "~/paraglide/messages.js";
import { COMPUTER_QUERY_KEY } from "./use-computer.ts";

/** The chat's folders in the composer: what is attached, and the ways to change that. */
export interface ComposerFolders {
  readonly items: ReadonlyArray<{
    readonly name: string;
    readonly readOnly: boolean;
    /** False when the folder was moved, renamed or deleted since it was attached. */
    readonly alive: boolean;
  }>;
  readonly onAdd: () => void;
  /** Picks a moved folder again, under the name it had. */
  readonly onChooseAgain: (name: string) => void;
  readonly onRemove: (name: string) => void;
  /** A pick or a detach is under way. */
  readonly busy: boolean;
}

export const desktopFoldersKey = (conversationId: string) =>
  ["desktop-folders", conversationId] as const;

/**
 * Folders are picked at the machine, so the composer offers them only in the desktop app, and
 * only where the chat's computer is this machine or none yet (a new chat included: its id exists
 * before the first send, and the machine holds the folder for it). The machine is the source of
 * truth for what is attached; the server hears the names from it.
 */
export function useComposerFolders(
  conversationId: string,
  machineId: string | null,
): ComposerFolders | undefined {
  const desktop = useDesktop();
  const here = useLocalMachineId();
  const queryClient = useQueryClient();
  const { data: capabilities } = useQuery(capabilitiesQuery);
  const usable =
    capabilities?.work === true &&
    desktop !== null &&
    here !== null &&
    (machineId === null || machineId === here);
  const status = useQuery({
    queryKey: desktopFoldersKey(conversationId),
    enabled: usable,
    queryFn: () => Effect.runPromise(desktop!.folderStatus({ conversationId })),
  });
  const settle = (next: FolderStatus) => {
    queryClient.setQueryData(desktopFoldersKey(conversationId), next);
    // A first folder binds a chat with no computer yet to this machine.
    void queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
    void queryClient.invalidateQueries({ queryKey: COMPUTER_QUERY_KEY });
  };
  const add = useMutation({
    mutationFn: (replace?: string) =>
      Effect.runPromise(
        desktop!.chooseFolder(replace ? { conversationId, replace } : { conversationId }),
      ),
    onSuccess: settle,
    onError: (error) =>
      toast.error(
        error instanceof DesktopError && error.reason === "already-exists"
          ? m.chat_composer_folder_name_taken()
          : m.chat_composer_folder_refused(),
      ),
  });
  const remove = useMutation({
    mutationFn: (name: string) =>
      Effect.runPromise(desktop!.detachFolder({ conversationId, name })),
    onSuccess: settle,
  });
  if (!usable) return undefined;
  return {
    items: (status.data?.folders ?? []).map(({ name, readOnly, alive }) => ({
      name,
      readOnly,
      alive,
    })),
    onAdd: () => add.mutate(undefined),
    onChooseAgain: (name) => add.mutate(name),
    onRemove: (name) => remove.mutate(name),
    busy: add.isPending || remove.isPending,
  };
}
