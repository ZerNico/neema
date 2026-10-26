import { m } from "~/paraglide/messages.js";
import { ComputerIcon, Delete02Icon, FolderAddIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { setPermissionLevel } from "~/modules/chat/server/functions.ts";
import { useDesktop, useLocalMachineId } from "~/modules/desktop/client/bridge.ts";
import { PERMISSION_LEVELS } from "~/modules/desktop/client/approvals.ts";
import { formatLocale } from "~/i18n/formats.ts";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import { Popover, PopoverContent, PopoverTrigger } from "~/ui/primitives/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/ui/primitives/select";
import { Separator } from "~/ui/primitives/separator";
import { PendingButton } from "~/ui/pending-button.tsx";
import {
  COMPUTER_QUERY_KEY,
  useComputerActions,
  useComputerSnapshot,
  useNetworkGrants,
} from "../client/use-computer.ts";
import { desktopFoldersKey } from "../client/use-composer-folders.ts";

/** What the conversation detail says about the chat's computer. */
export interface ChatComputer {
  readonly machineId: string | null;
  readonly machineName: string | null;
  readonly folders: ReadonlyArray<{ name: string; readOnly: boolean }>;
  readonly permissionLevel: "ask" | "allow";
}

type MachineStatus = NonNullable<
  ReturnType<typeof useComputerSnapshot>["data"]
>["machines"][number];

const statusLabel = (machine: MachineStatus | undefined) => {
  if (!machine?.online)
    return machine
      ? m.computer_status_offline_since({
          time: new Date(machine.lastSeenAt).toLocaleString(formatLocale(), {
            dateStyle: "short",
            timeStyle: "short",
          }),
        })
      : m.computer_status_offline();
  const computer = machine.computer;
  if (computer?.status === "preparing")
    return m.computer_status_preparing({ percent: Math.round(computer.progress * 100) });
  if (computer?.status === "unavailable") return m.computer_status_unavailable();
  return m.computer_status_online();
};

const sectionTitle = "text-muted-foreground text-xs font-medium";

/** Guest paths, the same the model uses: not words to translate. */
const WORKSPACE_PATH = "/workspace";
const folderPath = (name: string) => `/folders/${name}`;

/**
 * The chat's computer in the header: which machine it runs on and whether that is online, its
 * folders, how much it asks, the destinations this chat may reach, and the ways to move or reset
 * it. Shown once the chat has a computer; binding happens on its first local call.
 */
export function ComputerTag({
  conversationId,
  computer,
}: {
  conversationId: string;
  computer: ChatComputer;
}) {
  const snapshot = useComputerSnapshot();
  const machines = snapshot.data?.machines ?? [];
  const current = machines.find((machine) => machine.id === computer.machineId);
  if (!computer.machineId) return null;
  const name = current?.name ?? computer.machineName ?? m.computer_unknown_machine();
  const online = current?.online === true;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Badge
            variant="secondary"
            className="max-w-48 shrink"
            render={<button type="button" />}
          />
        }
      >
        {/* Wrapped for the status dot, so the badge's own icon size doesn't reach it. */}
        <span className="relative flex shrink-0">
          <HugeiconsIcon icon={ComputerIcon} strokeWidth={2} className="size-3" aria-hidden />
          <span
            className={`absolute -top-0.5 -right-0.5 size-1.5 rounded-full ${online ? "bg-success" : "bg-muted-foreground"}`}
            aria-hidden
          />
        </span>
        <span className="sr-only">{m.computer_tag_label()}</span>
        <span className="truncate">{name}</span>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={8} className="w-80">
        <ComputerPanel
          conversationId={conversationId}
          computer={computer}
          name={name}
          machine={current}
          others={machines.filter((machine) => machine.id !== computer.machineId)}
        />
      </PopoverContent>
    </Popover>
  );
}

function ComputerPanel({
  conversationId,
  computer,
  name,
  machine,
  others,
}: {
  conversationId: string;
  computer: ChatComputer;
  name: string;
  machine: MachineStatus | undefined;
  others: ReadonlyArray<MachineStatus>;
}) {
  const queryClient = useQueryClient();
  const desktop = useDesktop();
  const here = useLocalMachineId();
  // Folders are attached in the desktop app on the chat's own machine, never from elsewhere.
  const local = desktop !== null && here === computer.machineId;
  const actions = useComputerActions(conversationId);
  const { grants, remove } = useNetworkGrants();
  const chatGrants = (grants.data?.grants ?? []).filter(
    (grant) => grant.conversationId === conversationId,
  );
  const refreshChat = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] }),
      queryClient.invalidateQueries({ queryKey: COMPUTER_QUERY_KEY }),
      // The composer's folder chips read the machine directly.
      queryClient.invalidateQueries({ queryKey: desktopFoldersKey(conversationId) }),
    ]);
  const level = useMutation({
    mutationFn: (permissionLevel: "ask" | "allow") =>
      setPermissionLevel({ data: { conversationId, permissionLevel } }),
    onSettled: refreshChat,
  });
  const attach = useMutation({
    mutationFn: () => Effect.runPromise(desktop!.chooseFolder({ conversationId })),
    onSettled: refreshChat,
  });
  const detach = useMutation({
    mutationFn: (folder: string) =>
      Effect.runPromise(desktop!.detachFolder({ conversationId, name: folder })),
    onSettled: refreshChat,
  });
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div>
        <p className="font-medium">{name}</p>
        <p className="text-muted-foreground text-xs">{statusLabel(machine)}</p>
      </div>
      <Separator />
      <section className="flex flex-col gap-1.5">
        <p className={sectionTitle}>{m.computer_folders()}</p>
        <p className="text-muted-foreground font-mono text-xs">{WORKSPACE_PATH}</p>
        {computer.folders.map((folder) => (
          <div key={folder.name} className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-xs">
              {folderPath(folder.name)}
              {folder.readOnly ? ` · ${m.computer_folder_read_only()}` : ""}
            </span>
            {local ? (
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={m.computer_folder_remove({ name: folder.name })}
                onClick={() => detach.mutate(folder.name)}
              >
                <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
              </Button>
            ) : null}
          </div>
        ))}
        {local ? (
          <PendingButton
            size="sm"
            variant="outline"
            pending={attach.isPending}
            onClick={() => attach.mutate()}
          >
            <HugeiconsIcon icon={FolderAddIcon} strokeWidth={2} />
            {m.computer_attach()}
          </PendingButton>
        ) : (
          <p className="text-muted-foreground text-xs">
            {m.computer_attach_elsewhere({ machine: name })}
          </p>
        )}
      </section>
      <Separator />
      <section className="flex flex-col gap-1.5">
        <p className={sectionTitle}>{m.computer_permission()}</p>
        <Select
          value={computer.permissionLevel}
          items={PERMISSION_LEVELS.map((option) => ({
            value: option.value,
            label: option.label(),
          }))}
          onValueChange={(value) => level.mutate(value as "ask" | "allow")}
        >
          <SelectTrigger aria-label={m.computer_permission()} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PERMISSION_LEVELS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label()}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </section>
      <Separator />
      <section className="flex flex-col gap-1.5">
        <p className={sectionTitle}>{m.computer_destinations()}</p>
        {chatGrants.length === 0 ? (
          <p className="text-muted-foreground text-xs">{m.computer_destinations_none()}</p>
        ) : (
          chatGrants.map((grant) => (
            <div key={grant.id} className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-xs">
                {grant.host}:{grant.port}
              </span>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={m.computer_destination_remove({
                  destination: `${grant.host}:${grant.port}`,
                })}
                onClick={() => remove.mutate(grant.id)}
              >
                <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
              </Button>
            </div>
          ))
        )}
      </section>
      <Separator />
      <section className="flex flex-col gap-1.5">
        {others.length > 0 ? (
          <Select
            value=""
            items={others.map((other) => ({ value: other.id, label: other.name }))}
            onValueChange={(value) => actions.switchTo.mutate(value as string)}
          >
            <SelectTrigger aria-label={m.computer_switch()} className="w-full">
              <SelectValue placeholder={m.computer_switch()} />
            </SelectTrigger>
            <SelectContent>
              {others.map((other) => (
                <SelectItem key={other.id} value={other.id}>
                  {other.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <PendingButton
          size="sm"
          variant="outline"
          pending={actions.reset.isPending}
          disabled={!machine?.online}
          onClick={() => actions.reset.mutate()}
        >
          {m.computer_reset()}
        </PendingButton>
        <p className="text-muted-foreground text-xs">{m.computer_reset_note()}</p>
      </section>
    </div>
  );
}
