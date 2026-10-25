import { ArrowDown01Icon, Key01Icon } from "@hugeicons/core-free-icons";
import type { AgentChoiceReply, AgentSetting, DesktopNetwork } from "@chat/desktop-rpc";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { toastError } from "~/ui/error-toast.ts";
import { ListCard, ListRow, Section } from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Button } from "~/ui/primitives/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/ui/primitives/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { Input } from "~/ui/primitives/input";
import { m } from "~/paraglide/messages.js";

const QUERY_KEY = ["desktop-ssh-agent"] as const;

/**
 * Settings › This computer: the SSH agent commands sign in with. The app reads no ssh config to
 * find it, so an agent set only there (1Password, Secretive) is chosen here once. The desktop app
 * checks the socket answers as an agent.
 */
export function SshAgentSetting({ network }: { network: DesktopNetwork }) {
  const { agent, chooseAgent, forgetKeys } = network;
  if (!agent || !chooseAgent || !forgetKeys) return null;
  return (
    <AgentChoice
      load={() => agent()}
      choose={(socket) => chooseAgent(socket)}
      forget={() => forgetKeys()}
    />
  );
}

/** The agent as a person knows it: by its app's name, else where it comes from. */
const agentLabel = (current: NonNullable<AgentSetting["current"]>) =>
  current.name ??
  (current.source === "windows"
    ? m.settings_ssh_windows_agent()
    : current.source === "environment"
      ? m.settings_ssh_system_agent()
      : current.socket);

/** Whether it can sign anyone in: not running, empty, or how many keys it holds. */
const agentNote = (current: NonNullable<AgentSetting["current"]>, added: readonly string[]) =>
  !current.running
    ? m.settings_ssh_not_running()
    : current.keys === 0
      ? current.source === "environment" && added.length > 0
        ? m.settings_ssh_added_on_sign_in({ names: added.join(", "), count: added.length })
        : m.settings_ssh_no_keys()
      : current.keys === null
        ? null
        : m.settings_ssh_key_count({ count: current.keys });

function AgentChoice({
  load,
  choose,
  forget,
}: {
  load: () => Promise<AgentSetting>;
  choose: (socket: string | null) => Promise<AgentChoiceReply>;
  forget: () => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const [naming, setNaming] = useState(false);
  const setting = useQuery({ queryKey: QUERY_KEY, queryFn: load, retry: false });
  const change = useMutation({
    mutationFn: async (next: string | null) => {
      const reply = await choose(next);
      if (!reply.ok) throw new Error(reply.message);
      return reply.changed;
    },
    onSuccess: async (changed) => {
      if (!changed) return;
      setNaming(false);
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (error) => toastError(m.settings_ssh_error_change(), error),
  });
  const stopAdding = useMutation({
    mutationFn: forget,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
    onError: (error) => toastError(m.settings_ssh_error_change(), error),
  });
  const added = setting.data?.added ?? [];
  const current = setting.data?.current ?? null;
  const others = (setting.data?.found ?? []).filter((agent) => agent.socket !== current?.socket);
  const chosen = current?.source === "chosen";
  return (
    <Section title={m.settings_ssh_title()} description={m.settings_ssh_description()}>
      <ListCard>
        <ListRow>
          <HugeiconsIcon
            icon={Key01Icon}
            strokeWidth={2}
            className="text-muted-foreground size-5 shrink-0"
          />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="wrap-anywhere text-sm font-medium">
              {setting.isPending
                ? m.settings_computer_loading()
                : setting.isError
                  ? m.settings_ssh_error_load()
                  : current
                    ? agentLabel(current)
                    : m.settings_ssh_none()}
            </span>
            {current && agentNote(current, added) ? (
              <span className="text-muted-foreground text-xs">{agentNote(current, added)}</span>
            ) : null}
          </div>
          {setting.data?.choosable ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <PendingButton
                    variant="secondary"
                    size="sm"
                    pending={change.isPending || stopAdding.isPending}
                  />
                }
              >
                {m.settings_ssh_change()}
                <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} data-icon="inline-end" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {others.map((agent) => (
                  <DropdownMenuItem key={agent.socket} onClick={() => change.mutate(agent.socket)}>
                    {agent.name}
                  </DropdownMenuItem>
                ))}
                {chosen ? (
                  <DropdownMenuItem onClick={() => change.mutate(null)}>
                    {m.settings_ssh_system_agent()}
                  </DropdownMenuItem>
                ) : null}
                {others.length > 0 || chosen ? <DropdownMenuSeparator /> : null}
                <DropdownMenuItem onClick={() => setNaming(true)}>
                  {m.settings_ssh_other()}
                </DropdownMenuItem>
                {added.length > 0 ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => stopAdding.mutate()}>
                      {m.settings_ssh_stop_adding({ names: added.join(", ") })}
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </ListRow>
      </ListCard>
      <OtherAgentDialog
        open={naming}
        onOpenChange={setNaming}
        pending={change.isPending}
        onSubmit={(socket) => change.mutate(socket)}
      />
    </Section>
  );
}

/** An agent not on the known list, named by its socket's path. */
function OtherAgentDialog({
  open,
  onOpenChange,
  pending,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  onSubmit: (socket: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{m.settings_ssh_other_title()}</DialogTitle>
          <DialogDescription>{m.settings_ssh_other_description()}</DialogDescription>
        </DialogHeader>
        {/* Mounted while open, so each opening starts empty. */}
        {open ? <OtherAgentForm pending={pending} onSubmit={onSubmit} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function OtherAgentForm({
  pending,
  onSubmit,
}: {
  pending: boolean;
  onSubmit: (socket: string) => void;
}) {
  const id = useId();
  const [socket, setSocket] = useState("");
  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (socket.trim()) onSubmit(socket.trim());
      }}
    >
      <label htmlFor={id} className="sr-only">
        {m.settings_ssh_socket()}
      </label>
      <Input
        id={id}
        value={socket}
        onChange={(event) => setSocket(event.target.value)}
        // oxlint-disable-next-line i18n/no-literal-text -- a path, the same in every language
        placeholder="/path/to/agent.sock"
        spellCheck={false}
        autoComplete="off"
      />
      <DialogFooter>
        <DialogClose render={<Button variant="outline" disabled={pending} />}>
          {m.common_cancel()}
        </DialogClose>
        <PendingButton type="submit" disabled={!socket.trim()} pending={pending}>
          {m.settings_ssh_use()}
        </PendingButton>
      </DialogFooter>
    </form>
  );
}
