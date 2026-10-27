import { Globe02Icon, InternetIcon, LaptopIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { useState } from "react";
import { formatLocale } from "~/i18n/formats.ts";
import { COMPUTER_QUERY_KEY, useComputerSnapshot } from "~/modules/computer/client/use-computer.ts";
import {
  listNetworkGrants,
  removeNetworkGrant,
  moveChatsHere,
  renameComputer,
} from "~/modules/computer/server/functions.ts";
import { useDesktop, useLocalMachineId } from "~/modules/desktop/client/bridge.ts";
import { useDesktopBrowser } from "~/modules/browser/client/use-desktop-browser.ts";
import { BrowserSearchSetting } from "~/modules/browser/ui/search-engine-setting.tsx";
import { useConfirm } from "~/ui/confirm-context.ts";
import { toastError } from "~/ui/error-toast.ts";
import { EmptyState, ListCard, ListRow, Page, Section } from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import { Input } from "~/ui/primitives/input";
import { Switch } from "~/ui/primitives/switch";
import { m } from "~/paraglide/messages.js";

/** A destination as a person reads it: the host, with its port unless it is HTTPS's. */
export const destinationLabel = ({ host, port }: { host: string; port: number }) =>
  port === 443 ? host : `${host}:${port}`;

/**
 * One list of things allowed on this computer, each removable. Loading, an
 * error and an empty list are rows of the same card, so every section on the
 * page has one shape.
 */
function AllowedList<T>({
  title,
  description,
  queryKey,
  load,
  remove,
  label,
  itemKey = label,
  badge,
  icon,
  confirmRemove,
}: {
  title: string;
  description: string;
  queryKey: readonly string[];
  load: () => Promise<ReadonlyArray<T>>;
  remove: (item: T) => Promise<void>;
  /** What the row says; also its key unless `itemKey` gives one. */
  label: (item: T) => string;
  itemKey?: (item: T) => string;
  /** A short mark beside the label. */
  badge?: (item: T) => string | null;
  icon: IconSvgElement;
  confirmRemove: (item: T) => { title: string; description: string };
}) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const items = useQuery({ queryKey, queryFn: load, retry: false, refetchOnMount: "always" });
  const removal = useMutation({
    mutationFn: remove,
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
    onError: (error) => toastError(m.settings_computer_error_remove(), error),
  });
  // Only for taking an "always allow" back, so there is nothing to show until one is given.
  // Nothing while loading either, or the page would jump when an empty one vanished.
  if (items.isPending || (items.isSuccess && items.data.length === 0)) return null;
  return (
    <Section title={title} description={description}>
      <ListCard>
        {items.isError ? (
          <ListRow className="text-muted-foreground text-sm">
            <span role="alert" className="flex-1">
              {m.settings_computer_error_load()}
            </span>
            <PendingButton
              variant="ghost"
              size="sm"
              pending={items.isFetching}
              onClick={() => void items.refetch()}
            >
              {m.common_retry()}
            </PendingButton>
          </ListRow>
        ) : (
          items.data.map((item) => (
            <ListRow key={itemKey(item)}>
              <HugeiconsIcon
                icon={icon}
                strokeWidth={2}
                className="text-muted-foreground size-5 shrink-0"
              />
              <span className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium">
                <span className="min-w-0 wrap-anywhere">{label(item)}</span>
                {badge?.(item) ? <Badge variant="secondary">{badge(item)}</Badge> : null}
              </span>
              <PendingButton
                variant="ghost"
                size="sm"
                pending={removal.isPending && removal.variables === item}
                onClick={async () => {
                  if (await confirm({ ...confirmRemove(item), confirmLabel: m.common_remove() }))
                    removal.mutate(item);
                }}
              >
                {m.common_remove()}
              </PendingButton>
            </ListRow>
          ))
        )}
      </ListCard>
    </Section>
  );
}

/**
 * Settings › This computer: the machine the app runs on, its chat computers and what they may
 * reach. The machine's own settings exist only in the desktop app; the destinations every chat
 * may reach and the list of computers are the account's, so a browser shows them too.
 */
export function ComputerPage() {
  const desktop = useDesktop();
  const agent = useDesktopBrowser()?.agent;
  return (
    <Page
      title={m.settings_section_computer()}
      rootPath="/settings"
      rootLabel={m.common_settings()}
    >
      {desktop ? (
        <ThisComputer />
      ) : (
        <EmptyState
          icon={LaptopIcon}
          title={m.settings_computer_desktop_only_title()}
          description={m.settings_computer_desktop_only_description()}
        />
      )}
      <Machines />
      <AllowedList
        title={m.settings_computer_network_title()}
        description={m.settings_computer_network_description()}
        queryKey={["computer", "grants", "everywhere"]}
        load={async () =>
          (await listNetworkGrants()).grants.filter((grant) => grant.conversationId === null)
        }
        remove={async (grant) => {
          await removeNetworkGrant({ data: { grantId: grant.id } });
        }}
        label={destinationLabel}
        itemKey={(grant) => grant.id}
        badge={(grant) => (grant.privateNetwork ? m.settings_computer_private_network() : null)}
        icon={InternetIcon}
        confirmRemove={(grant) => ({
          title: m.settings_computer_remove_title({ name: destinationLabel(grant) }),
          description: m.settings_computer_network_remove_description(),
        })}
      />
      <BrowserSearchSetting />
      {agent ? (
        <AllowedList
          title={m.settings_computer_sites_title()}
          description={m.settings_computer_sites_description()}
          queryKey={["desktop-browser-sites"]}
          load={() => agent.allowedSites()}
          remove={(site) => agent.revokeSite(site)}
          label={(site) => site}
          icon={Globe02Icon}
          confirmRemove={(site) => ({
            title: m.settings_computer_remove_title({ name: site }),
            description: m.settings_computer_site_remove_description(),
          })}
        />
      ) : null}
    </Page>
  );
}

const STATUS_KEY = ["desktop-computer-status"] as const;

/** This machine: whether its chat computers can run, remote use, and the SSH agent to relay. */
function ThisComputer() {
  const desktop = useDesktop()!;
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: STATUS_KEY,
    queryFn: () => Effect.runPromise(desktop.computerStatus(undefined)),
    // The image download moves the status along; nothing else announces it here.
    refetchInterval: (query) => (query.state.data?.status === "preparing" ? 2_000 : false),
  });
  const update = (data: Awaited<ReturnType<typeof status.refetch>>["data"]) =>
    queryClient.setQueryData(STATUS_KEY, data);
  const remote = useMutation({
    mutationFn: (enabled: boolean) => Effect.runPromise(desktop.setRemoteControl({ enabled })),
    onSuccess: update,
    onError: (error) => toastError(m.settings_computer_error_change(), error),
  });
  const socket = useMutation({
    mutationFn: (path: string | null) => Effect.runPromise(desktop.setAgentSocket({ path })),
    onSuccess: update,
    onError: (error) => toastError(m.settings_computer_error_change(), error),
  });
  const [draft, setDraft] = useState<string | null>(null);
  const current = status.data;
  const label =
    current?.status === "ready"
      ? m.settings_computer_status_ready()
      : current?.status === "preparing"
        ? m.computer_status_preparing({ percent: Math.round(current.progress * 100) })
        : current?.status === "unavailable"
          ? m.settings_computer_status_unavailable({ reason: current.reason })
          : m.settings_computer_loading();
  return (
    <Section title={m.settings_computer_this_title()}>
      <ListCard>
        <ListRow>
          <span className="flex-1 text-sm font-medium">{m.settings_computer_status_label()}</span>
          <span className="text-muted-foreground text-sm">{label}</span>
        </ListRow>
        <ListRow>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium">{m.settings_computer_remote_allow()}</span>
            <span className="text-muted-foreground text-xs">
              {m.settings_computer_remote_hint()}
            </span>
          </span>
          <Switch
            aria-label={m.settings_computer_remote_allow()}
            checked={current?.remote ?? true}
            disabled={!current || remote.isPending}
            onCheckedChange={(enabled) => remote.mutate(enabled)}
          />
        </ListRow>
        <ListRow className="flex-col items-stretch gap-2">
          <span className="flex min-w-0 flex-col">
            <span className="text-sm font-medium">{m.settings_computer_agent_title()}</span>
            <span className="text-muted-foreground text-xs">
              {m.settings_computer_agent_hint()}
            </span>
          </span>
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const value = (draft ?? current?.agentSocket ?? "").trim();
              socket.mutate(value === "" ? null : value, { onSuccess: () => setDraft(null) });
            }}
          >
            <Input
              aria-label={m.settings_computer_agent_title()}
              placeholder={m.settings_computer_agent_placeholder()}
              value={draft ?? current?.agentSocket ?? ""}
              onChange={(event) => setDraft(event.target.value)}
            />
            <PendingButton
              type="submit"
              variant="outline"
              pending={socket.isPending}
              disabled={draft === null}
            >
              {m.common_save()}
            </PendingButton>
          </form>
        </ListRow>
      </ListCard>
    </Section>
  );
}

/** Every machine that ever connected, and whether it is online, so a chat's computer has a name. */
function Machines() {
  const snapshot = useComputerSnapshot();
  const here = useLocalMachineId();
  const machines = snapshot.data?.machines ?? [];
  if (machines.length === 0) return null;
  // Chats move to the computer this page runs on, so only a desktop app offers it.
  return (
    <Section title={m.settings_computer_machines_title()}>
      <ListCard>
        {machines.map((machine) => (
          <MachineRow
            key={machine.id}
            machine={machine}
            here={machine.id === here}
            canMoveHere={here !== null && machine.id !== here}
          />
        ))}
      </ListCard>
    </Section>
  );
}

/**
 * One machine, renamed in place: two of the same model report the same name, and the person's
 * own tells them apart everywhere the machine is named. A blank name goes back to the reported one.
 */
function MachineRow({
  machine,
  here,
  canMoveHere,
}: {
  machine: { id: string; name: string; online: boolean; lastSeenAt: string };
  here: boolean;
  canMoveHere: boolean;
}) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const move = useMutation({
    mutationFn: () => moveChatsHere({ data: { fromMachineId: machine.id } }),
    onError: (error) => toastError(m.settings_computer_move_chats_failed(), error),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: COMPUTER_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: ["conversation"] }),
      ]),
  });
  const moveChats = async () => {
    const confirmed = await confirm({
      title: m.settings_computer_move_chats_title({ machine: machine.name }),
      description: m.settings_computer_move_chats_note({ machine: machine.name }),
      confirmLabel: m.settings_computer_move_chats(),
      destructive: false,
    });
    if (confirmed) move.mutate();
  };
  const [draft, setDraft] = useState<string | null>(null);
  const rename = useMutation({
    mutationFn: (name: string) => renameComputer({ data: { machineId: machine.id, name } }),
    onError: (error) => toastError(m.settings_computer_rename_failed(), error),
    onSettled: () => queryClient.invalidateQueries({ queryKey: COMPUTER_QUERY_KEY }),
  });
  const finish = () => {
    if (draft !== null && draft.trim() !== machine.name) rename.mutate(draft);
    setDraft(null);
  };
  const status = machine.online
    ? m.computer_status_online()
    : m.computer_status_offline_since({
        time: new Date(machine.lastSeenAt).toLocaleString(formatLocale(), {
          dateStyle: "short",
          timeStyle: "short",
        }),
      });
  // Laid out like a device on the Devices page: name and mark, then its state, then actions.
  return (
    <ListRow>
      <HugeiconsIcon
        icon={LaptopIcon}
        strokeWidth={2}
        className="text-muted-foreground size-5 shrink-0"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {draft === null ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">
              {rename.isPending ? rename.variables : machine.name}
            </span>
            {here ? <Badge variant="secondary">{m.settings_section_computer()}</Badge> : null}
          </div>
        ) : (
          <Input
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- opened by the rename button for typing
            autoFocus
            aria-label={m.settings_computer_name()}
            value={draft}
            maxLength={60}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={finish}
            onKeyDown={(event) => {
              if (event.key === "Enter") finish();
              if (event.key === "Escape") setDraft(null);
            }}
          />
        )}
        <span className="text-muted-foreground text-xs">{status}</span>
      </div>
      {draft === null ? (
        <div className="flex shrink-0 gap-1">
          {canMoveHere ? (
            <PendingButton
              variant="ghost"
              size="sm"
              pending={move.isPending}
              onClick={() => void moveChats()}
            >
              {m.settings_computer_move_chats()}
            </PendingButton>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            aria-label={m.settings_computer_rename({ name: machine.name })}
            onClick={() => setDraft(machine.name)}
          >
            {m.settings_computer_rename_button()}
          </Button>
        </div>
      ) : null}
    </ListRow>
  );
}
