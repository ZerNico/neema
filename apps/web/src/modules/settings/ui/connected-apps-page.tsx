import { Copy01Icon, McpServerIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useRef, useState, type ReactNode } from "react";
import { connectedAppsQuery } from "~/modules/mcp-server/client/queries.ts";
import { accessSummary } from "~/modules/mcp-server/scopes.ts";
import { revokeConnectedApp } from "~/modules/mcp-server/server/functions.ts";
import { useConfirm } from "~/ui/confirm-context.ts";
import { toastError } from "~/ui/error-toast.ts";
import { EmptyState, ListCard, ListRow, Page, Section } from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Button } from "~/ui/primitives/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/ui/primitives/tabs";
import { m } from "~/paraglide/messages.js";
import { formatLocale } from "~/i18n/formats.ts";
import { RichText } from "~/ui/rich-text.tsx";

const when = (value: Date | string) =>
  new Intl.DateTimeFormat(formatLocale(), { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );

export function ConnectedAppsPage() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { data } = useSuspenseQuery(connectedAppsQuery);
  const revoke = useMutation({
    mutationFn: (clientId: string) => revokeConnectedApp({ data: { clientId } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: connectedAppsQuery.queryKey }),
    onError: (error) => toastError(m.settings_apps_error_revoke(), error),
  });

  return (
    <Page
      title={m.settings_section_connected_apps()}
      rootPath="/settings"
      rootLabel={m.common_settings()}
    >
      <Section
        title={m.settings_apps_server_title()}
        description={m.settings_apps_server_description()}
      >
        {data.serverUrl ? (
          <ServerAddress url={data.serverUrl} />
        ) : (
          <p className="text-muted-foreground text-sm">{m.settings_apps_needs_https()}</p>
        )}
        {data.allowed ? null : (
          <p className="text-muted-foreground text-sm">{m.settings_apps_not_allowed()}</p>
        )}
      </Section>
      {data.serverUrl ? <Setup url={data.serverUrl} /> : null}
      <Section title={m.settings_apps_connected()}>
        {data.apps.length === 0 ? (
          <EmptyState icon={McpServerIcon} title={m.settings_apps_empty()} />
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
                      ? m.settings_apps_last_active({ date: when(app.lastActiveAt) })
                      : m.settings_apps_connected_at({ date: when(app.connectedAt) })}
                  </span>
                </div>
                <PendingButton
                  variant="ghost"
                  size="sm"
                  pending={revoke.isPending && revoke.variables === app.clientId}
                  onClick={async () => {
                    if (
                      await confirm({
                        title: m.settings_apps_revoke_title({ name: app.name }),
                        description: m.settings_apps_revoke_description(),
                        confirmLabel: m.settings_apps_revoke(),
                      })
                    )
                      revoke.mutate(app.clientId);
                  }}
                >
                  {m.settings_apps_revoke()}
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
        {copied ? m.common_copied() : m.common_copy()}
      </Button>
    </div>
  );
}

/** How each kind of client is pointed here, with this instance's own address filled in. */
const setups = (url: string) => [
  {
    id: "claude-code",
    label: "Claude Code",
    note: m.settings_apps_setup_claude_code(),
    code: `claude mcp add --transport http neema ${url}`,
  },
  {
    id: "config",
    label: m.settings_apps_setup_config_label(),
    note: m.settings_apps_setup_config(),
    code: JSON.stringify({ mcpServers: { neema: { url } } }, null, 2),
  },
  {
    id: "key",
    label: m.settings_apps_setup_key_label(),
    note: null,
    code: JSON.stringify(
      { mcpServers: { neema: { url, headers: { Authorization: "Bearer nma_…" } } } },
      null,
      2,
    ),
  },
];

/** The link inside the API key setup note, to the page that makes keys. */
const API_KEYS_LINK = {
  link: (children: ReactNode) => (
    <Link to="/settings/api-keys" className="text-foreground underline">
      {children}
    </Link>
  ),
};

function Setup({ url }: { url: string }) {
  return (
    <Section title={m.settings_apps_setup()}>
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
                  <RichText parts={m.settings_apps_setup_key.parts()} tags={API_KEYS_LINK} />
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
