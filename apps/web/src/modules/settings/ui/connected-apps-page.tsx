import { Copy01Icon, McpServerIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { connectedAppsQuery } from "~/modules/mcp-server/client/queries.ts";
import { accessSummary } from "~/modules/mcp-server/scopes.ts";
import { revokeConnectedApp } from "~/modules/mcp-server/server/functions.ts";
import { useConfirm } from "~/ui/confirm-context.ts";
import { toastError } from "~/ui/error-toast.ts";
import { EmptyState, ListCard, ListRow, Page, Section } from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Button } from "~/ui/primitives/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/ui/primitives/tabs";

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const when = (value: Date | string) => dateFormat.format(new Date(value));

export function ConnectedAppsPage() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { data } = useSuspenseQuery(connectedAppsQuery);
  const revoke = useMutation({
    mutationFn: (clientId: string) => revokeConnectedApp({ data: { clientId } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: connectedAppsQuery.queryKey }),
    onError: (error) => toastError("Could not disconnect the app.", error),
  });

  return (
    <Page title="Connected apps" rootPath="/settings" rootLabel="Settings">
      <Section
        title="Server address"
        description="Add this as an MCP server in Claude, Cursor or another app."
      >
        {data.serverUrl ? (
          <ServerAddress url={data.serverUrl} />
        ) : (
          <p className="text-muted-foreground text-sm">
            Apps can connect once PUBLIC_URL is an https address.
          </p>
        )}
        {data.allowed ? null : (
          <p className="text-muted-foreground text-sm">
            Your account isn’t allowed to connect apps. Ask an admin.
          </p>
        )}
      </Section>
      {data.serverUrl ? <Setup url={data.serverUrl} /> : null}
      <Section title="Connected">
        {data.apps.length === 0 ? (
          <EmptyState icon={McpServerIcon} title="No apps connected" />
        ) : (
          <ListCard>
            {data.apps.map((app) => (
              <ListRow key={app.clientId}>
                <HugeiconsIcon
                  icon={McpServerIcon}
                  strokeWidth={2}
                  className="text-muted-foreground size-5 shrink-0"
                />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-sm font-medium">
                    {app.name}
                    {app.verifiedHost ? (
                      <span className="text-muted-foreground font-normal">
                        {" "}
                        · {app.verifiedHost}
                      </span>
                    ) : null}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {accessSummary(app.scopes)} ·{" "}
                    {app.lastActiveAt
                      ? `Last active ${when(app.lastActiveAt)}`
                      : `Connected ${when(app.connectedAt)}`}
                  </span>
                </div>
                <PendingButton
                  variant="ghost"
                  size="sm"
                  pending={revoke.isPending && revoke.variables === app.clientId}
                  onClick={async () => {
                    if (
                      await confirm({
                        title: `Disconnect ${app.name}?`,
                        description: "It loses access at once and has to be connected again.",
                        confirmLabel: "Disconnect",
                      })
                    )
                      revoke.mutate(app.clientId);
                  }}
                >
                  Disconnect
                </PendingButton>
              </ListRow>
            ))}
          </ListCard>
        )}
      </Section>
    </Page>
  );
}

function ServerAddress({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  return (
    <div className="flex items-center gap-2">
      <code className="bg-muted min-w-0 flex-1 truncate rounded-2xl px-4 py-3 font-mono text-sm select-all">
        {url}
      </code>
      <Button
        variant="outline"
        onClick={() => {
          void navigator.clipboard.writeText(url).then(() => {
            clearTimeout(timer.current);
            setCopied(true);
            timer.current = setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} strokeWidth={2} />
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

/** How each kind of client is pointed here, with this instance's own address filled in. */
const setups = (url: string) => [
  {
    id: "claude-code",
    label: "Claude Code",
    note: "Run this, then /mcp to sign in.",
    code: `claude mcp add --transport http neema ${url}`,
  },
  {
    id: "config",
    label: "Cursor and others",
    note: "Add this to the app’s MCP settings. It asks you to sign in on first use.",
    code: JSON.stringify({ mcpServers: { neema: { url } } }, null, 2),
  },
  {
    id: "key",
    label: "With an API key",
    note: null,
    code: JSON.stringify(
      { mcpServers: { neema: { url, headers: { Authorization: "Bearer nma_…" } } } },
      null,
      2,
    ),
  },
];

function Setup({ url }: { url: string }) {
  return (
    <Section title="Setup">
      <Tabs defaultValue="claude-code">
        <TabsList>
          {setups(url).map((setup) => (
            <TabsTrigger key={setup.id} value={setup.id}>
              {setup.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {setups(url).map((setup) => (
          <TabsContent key={setup.id} value={setup.id}>
            <div className="flex flex-col gap-2">
              <p className="text-muted-foreground text-sm">
                {setup.note ?? (
                  <>
                    For scripts and services that can’t sign in. Make a key in{" "}
                    <Link to="/settings/api-keys" className="text-foreground underline">
                      API keys
                    </Link>{" "}
                    and send it in the Authorization header.
                  </>
                )}
              </p>
              <pre className="bg-muted overflow-x-auto rounded-2xl px-4 py-3 font-mono text-sm">
                {setup.code}
              </pre>
            </div>
          </TabsContent>
        ))}
      </Tabs>
    </Section>
  );
}
