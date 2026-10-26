import type { PermissionLevel } from "~/modules/chat/schema.ts";
import { m } from "~/paraglide/messages.js";
import { Cancel01Icon, Folder01Icon, LaptopIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { setPermissionLevel } from "~/modules/chat/server/functions.ts";
import { useDesktop, useLocalMachineId } from "~/modules/desktop/client/bridge.ts";
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
import { useConfirm } from "~/ui/confirm-context.ts";
import { PERMISSION_LEVELS } from "~/modules/desktop/client/approvals.ts";
import { PendingButton } from "~/ui/pending-button.tsx";
import {
  COMPUTER_QUERY_KEY,
  useComputerActions,
  useComputerSnapshot,
  useNetworkGrants,
} from "../client/use-computer.ts";

/** What the conversation detail says about the chat's computer. */
export interface ChatComputer {
  readonly machineId: string | null;
  readonly machineName: string | null;
  readonly folders: ReadonlyArray<{ name: string; readOnly: boolean }>;
  readonly permissionLevel: PermissionLevel;
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
          <HugeiconsIcon icon={LaptopIcon} strokeWidth={2} className="size-3" aria-hidden />
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
  // The chat's own machine, in its desktop app: there the composer's strip has the folders.
  const local = desktop !== null && here === computer.machineId;
  const actions = useComputerActions(conversationId);
  const confirm = useConfirm();
  const { grants, remove } = useNetworkGrants();
  const chatGrants = (grants.data?.grants ?? []).filter(
    (grant) => grant.conversationId === conversationId,
  );
  const refreshChat = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] }),
      queryClient.invalidateQueries({ queryKey: COMPUTER_QUERY_KEY }),
    ]);
  const level = useMutation({
    mutationFn: (permissionLevel: PermissionLevel) =>
      setPermissionLevel({ data: { conversationId, permissionLevel } }),
    onSettled: refreshChat,
  });
  const reset = async () => {
    const confirmed = await confirm({
      title: m.computer_reset_title(),
      description: m.computer_reset_note(),
      confirmLabel: m.computer_reset_confirm(),
      // Nothing of the person's goes: only what the chat installed, which comes back when needed.
      destructive: false,
    });
    if (confirmed) actions.reset.mutate();
  };
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <p className="truncate font-medium">{name}</p>
        <p className="text-muted-foreground shrink-0 text-xs">{statusLabel(machine)}</p>
      </div>
      {/* On the chat's own machine, its folders and how much it asks are in the strip under the
          composer, beside the work they govern; here they are only told. */}
      {local ? null : (
        <section className="flex flex-col gap-1">
          <p className={sectionTitle}>{m.computer_folders()}</p>
          {computer.folders.map((folder) => (
            <div key={folder.name} className="flex min-w-0 items-center gap-2">
              <HugeiconsIcon
                icon={Folder01Icon}
                strokeWidth={2}
                className="text-muted-foreground size-3.5 shrink-0"
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate">
                {folder.name}
                {folder.readOnly ? (
                  <span className="text-muted-foreground"> · {m.computer_folder_read_only()}</span>
                ) : null}
              </span>
            </div>
          ))}
          <p className="text-muted-foreground text-xs">
            {m.computer_attach_elsewhere({ machine: name })}
          </p>
        </section>
      )}
      {local ? null : (
        <section className="flex flex-col gap-1">
          <p className={sectionTitle}>{m.computer_permission()}</p>
          <Select
            value={computer.permissionLevel}
            items={PERMISSION_LEVELS.map((option) => ({
              value: option.value,
              label: option.label(),
            }))}
            onValueChange={(value) => {
              const chosen = PERMISSION_LEVELS.find((option) => option.value === value);
              if (chosen) level.mutate(chosen.value);
            }}
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
      )}
      {chatGrants.length > 0 ? (
        <section className="flex flex-col gap-1">
          <p className={sectionTitle}>{m.computer_destinations()}</p>
          {chatGrants.map((grant) => {
            const destination = grant.port === 443 ? grant.host : `${grant.host}:${grant.port}`;
            return (
              <div key={grant.id} className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate">{destination}</span>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={m.computer_destination_remove({ destination })}
                  onClick={() => remove.mutate(grant.id)}
                >
                  <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
                </Button>
              </div>
            );
          })}
        </section>
      ) : null}
      <Separator />
      <div className="flex flex-col gap-1.5">
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
          variant="ghost"
          pending={actions.reset.isPending}
          disabled={!machine?.online}
          onClick={() => void reset()}
        >
          {m.computer_reset()}
        </PendingButton>
      </div>
    </div>
  );
}
