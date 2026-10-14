import { Key01Icon } from "@hugeicons/core-free-icons";
import type { AgentChoiceReply, AgentSetting, DesktopNetwork } from "@chat/desktop-rpc";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { toastError } from "~/ui/error-toast.ts";
import { ListCard, ListRow, Section } from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Input } from "~/ui/primitives/input";

const QUERY_KEY = ["desktop-ssh-agent"] as const;

/**
 * Settings › This computer: the SSH agent commands sign in with. The app reads no ssh config to
 * find it, so an agent set only there (1Password, Secretive) is named here once. The desktop app
 * checks the socket answers as an agent and asks the person itself.
 */
export function SshAgentSetting({ network }: { network: DesktopNetwork }) {
  const { agent, chooseAgent } = network;
  if (!agent || !chooseAgent) return null;
  return <AgentChoice load={() => agent()} choose={(socket) => chooseAgent(socket)} />;
}

/** What the row says under the agent: where it comes from, or that it is missing. */
const note = (setting: AgentSetting) => {
  if (setting.chosen) return setting.chosenFound ? null : "Not running";
  if (setting.fallbackFrom === "environment") return "From SSH_AUTH_SOCK";
  if (setting.fallbackFrom === "windows") return "Windows’ own agent";
  return null;
};

function AgentChoice({
  load,
  choose,
}: {
  load: () => Promise<AgentSetting>;
  choose: (socket: string | null) => Promise<AgentChoiceReply>;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const [socket, setSocket] = useState("");
  const setting = useQuery({ queryKey: QUERY_KEY, queryFn: load, retry: false });
  const change = useMutation({
    mutationFn: async (next: string | null) => {
      const reply = await choose(next);
      if (!reply.ok) throw new Error(reply.message);
      return reply.changed;
    },
    onSuccess: async (changed) => {
      if (!changed) return;
      setSocket("");
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (error) => toastError("Couldn’t change the agent.", error),
  });
  const current = setting.data;
  const detail = current ? note(current) : null;
  return (
    <Section
      title="SSH agent"
      description="Chats you allow to sign in with SSH use this agent. Name its socket here when it’s set only in your SSH config, as 1Password and Secretive do."
    >
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
                ? "Loading…"
                : setting.isError
                  ? "Couldn’t load the agent."
                  : (current?.chosen ?? current?.fallback ?? "No agent found")}
            </span>
            {detail ? <span className="text-muted-foreground text-xs">{detail}</span> : null}
          </div>
          {current?.chosen ? (
            <PendingButton
              variant="ghost"
              size="sm"
              pending={change.isPending && change.variables === null}
              onClick={() => change.mutate(null)}
            >
              Use default
            </PendingButton>
          ) : null}
        </ListRow>
        {current?.choosable ? (
          <ListRow>
            <form
              className="flex min-w-0 flex-1 items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (socket.trim()) change.mutate(socket.trim());
              }}
            >
              <label htmlFor={id} className="sr-only">
                Agent socket
              </label>
              <Input
                id={id}
                value={socket}
                onChange={(event) => setSocket(event.target.value)}
                placeholder="/Users/you/.1password/agent.sock"
                spellCheck={false}
                autoComplete="off"
              />
              <PendingButton
                type="submit"
                variant="secondary"
                size="sm"
                disabled={!socket.trim()}
                pending={change.isPending && change.variables !== null}
              >
                Use
              </PendingButton>
            </form>
          </ListRow>
        ) : null}
      </ListCard>
    </Section>
  );
}
