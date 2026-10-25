import { getLocale } from "~/paraglide/runtime.js";
import { m } from "~/paraglide/messages.js";
import {
  Delete02Icon,
  MoreHorizontalIcon,
  PencilEdit02Icon,
  PlugSocketIcon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { AccessDialog } from "~/modules/sharing/ui/access-dialog.tsx";
import { absoluteLabel } from "~/modules/chat/ui/timestamps.ts";
import { useConfirm } from "~/ui/confirm-context.ts";
import { toastError } from "~/ui/error-toast.ts";
import { EmptyState, ListCard, ListRow, Page, Section } from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Button } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/ui/primitives/select";
import { FieldError } from "~/ui/primitives/field";
import { Switch } from "~/ui/primitives/switch";
import { cn } from "~/ui/utils";
import { integrationLook } from "../client/directory.ts";
import { adminIntegrationsQuery } from "../client/queries.ts";
import type { ToolAccess } from "../manifest.ts";
import { MCP_LIMITS } from "../mcp/catalog.ts";
import { findKnownMcpServer } from "../mcp/known-servers.ts";
import type { AdminIntegration, AdminTool } from "../schema.ts";
import {
  checkIntegrationTools,
  deleteIntegration,
  saveIntegrationConfig,
  setIntegrationTool,
} from "../server/functions.ts";
import { IntegrationConfigDialog } from "./integration-config-dialog.tsx";
import { accessChoices } from "./tool-permissions.tsx";
import { toolText } from "../tool-text.ts";

/** What a tool says of itself, beside the admin's correction. */
const CLAIMS: Record<ToolAccess, () => string> = {
  read: m.integrations_tool_claim_read,
  write: m.integrations_tool_claim_write,
  destructive: m.integrations_tool_claim_destructive,
};

/**
 * One integration as the admin runs it: its settings, who may connect, and
 * its tools for everyone. A tool's server may say too little of what it does,
 * so its access can be corrected here; nothing a server lists waits on this.
 */
export function AdminIntegrationPage({ integrationId }: { integrationId: string }) {
  const { data } = useSuspenseQuery(adminIntegrationsQuery);
  const row = data.integrations.find((entry) => entry.id === integrationId);
  const [editing, setEditing] = useState(false);
  const [sharing, setSharing] = useState(false);
  const look = row ? integrationLook(row) : null;
  if (!row || !look)
    return (
      <Page
        title={m.integrations_detail_fallback_title()}
        backTo="/admin/integrations"
        backLabel={m.integrations_admin_title()}
      >
        <EmptyState
          icon={PlugSocketIcon}
          title={m.integrations_detail_not_found_title()}
          description={m.integrations_admin_deleted_hint()}
        />
      </Page>
    );
  // The address set for this instance; without one, the address it was opened at.
  const origin = data.origin ?? (typeof window === "undefined" ? null : window.location.origin);
  const note = origin ? findKnownMcpServer(row.server)?.setup?.(origin)(getLocale()) : undefined;

  return (
    <Page
      title={row.name}
      description={look.description(getLocale())}
      backTo="/admin/integrations"
      backLabel={m.integrations_admin_title()}
      actions={<IntegrationActions row={row} onEdit={() => setEditing(true)} />}
    >
      {note ? <p className="text-muted-foreground text-sm">{note}</p> : null}
      <Section title={m.common_settings()}>
        <ListCard>
          <ListRow>
            <EnabledSwitch row={row} />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm font-medium">
                {row.enabled ? m.integrations_admin_on() : m.integrations_admin_off()}
              </span>
              <span className="text-muted-foreground truncate text-xs">
                {row.config.url ?? row.config.baseUrl ?? row.config.site ?? look.name}
              </span>
            </div>
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              {m.common_edit()}
            </Button>
          </ListRow>
        </ListCard>
      </Section>
      <Section title={m.integrations_admin_audience_title()}>
        <ListCard>
          <ListRow>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm font-medium">
                {row.audience === "instance"
                  ? m.integrations_admin_audience_everyone()
                  : m.integrations_admin_audience_chosen()}
              </span>
              <span className="text-muted-foreground truncate text-xs">
                {m.integrations_admin_people_connected({ count: row.connectionCount })}
              </span>
            </div>
            <Button size="sm" variant="outline" onClick={() => setSharing(true)}>
              {m.integrations_admin_audience_change()}
            </Button>
          </ListRow>
        </ListCard>
      </Section>
      <ToolsSection row={row} />
      {editing ? <IntegrationConfigDialog row={row} open onOpenChange={setEditing} /> : null}
      {sharing ? (
        <AccessDialog
          resource={{ kind: "integration", id: row.id }}
          title={row.name}
          open
          onOpenChange={setSharing}
        />
      ) : null}
    </Page>
  );
}

/**
 * On or off as it is otherwise stored. Off stops chat tools and syncing and
 * keeps connections; the server refuses on while nobody has a way in.
 */
function EnabledSwitch({ row }: { row: AdminIntegration }) {
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      saveIntegrationConfig({
        data: {
          integrationId: row.id,
          name: row.name,
          description: row.description ?? "",
          enabled,
          config: { ...row.config },
          oauthClientId: row.oauthClientId ?? "",
          allowApiKeys: row.allowApiKeys,
        },
      }),
    onSuccess: async (result, enabled) => {
      if (!result.ok)
        toastError(
          enabled ? m.integrations_admin_turn_on_error() : m.integrations_admin_turn_off_error(),
          new Error(result.error),
        );
      await queryClient.invalidateQueries({ queryKey: adminIntegrationsQuery.queryKey });
    },
    onError: (error) => toastError(m.integrations_admin_toggle_error(), error),
  });
  return (
    <Switch
      checked={toggle.isPending ? toggle.variables : row.enabled}
      disabled={toggle.isPending}
      onCheckedChange={(enabled) => toggle.mutate(enabled)}
      aria-label={m.integrations_admin_enabled_label({ name: row.name })}
    />
  );
}

function IntegrationActions({ row, onEdit }: { row: AdminIntegration; onEdit: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const remove = useMutation({
    mutationFn: () => deleteIntegration({ data: { integrationId: row.id } }),
    onSuccess: async (result) => {
      if (!result.ok) {
        toastError(m.integrations_admin_delete_error(), new Error(result.error));
        return;
      }
      await navigate({ to: "/admin/integrations" });
      await queryClient.invalidateQueries({ queryKey: adminIntegrationsQuery.queryKey });
    },
    onError: (error) => toastError(m.integrations_admin_delete_error(), error),
  });
  const request = async () => {
    const people = row.connectionCount;
    if (
      await confirm({
        title: m.integrations_admin_delete_title({ name: row.name }),
        description: people
          ? m.integrations_admin_delete_description_people({ count: people })
          : m.integrations_admin_delete_description(),
        confirmLabel: m.common_delete(),
      })
    )
      remove.mutate();
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button size="icon-sm" variant="ghost" aria-label={m.integrations_admin_actions()} />
        }
      >
        <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={onEdit}>
          <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} />
          {m.integrations_admin_edit_settings()}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {/* A menu item cannot hold a spinner; disabled is its pending state. */}
        <DropdownMenuItem
          variant="destructive"
          disabled={remove.isPending}
          onClick={() => void request()}
        >
          <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
          {m.common_delete()}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Every tool any account sees, each on or off for everyone and at what it does. */
function ToolsSection({ row }: { row: AdminIntegration }) {
  const queryClient = useQueryClient();
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: adminIntegrationsQuery.queryKey });
  const check = useMutation({
    mutationFn: () => checkIntegrationTools({ data: { integrationId: row.id } }),
    onSuccess: async (result) => {
      if (!result.ok) toastError(m.integrations_check_tools_error(), new Error(result.error));
      await refresh();
    },
    onError: (error) => toastError(m.integrations_check_tools_error(), error),
  });
  const set = useMutation({
    mutationFn: (input: { tool: AdminTool; off: boolean; access: ToolAccess }) =>
      setIntegrationTool({
        data: {
          integrationId: row.id,
          tool: input.tool.name,
          off: input.off,
          // Back to what it claims is no correction at all.
          access: input.access === input.tool.claimed ? null : input.access,
        },
      }),
    onSuccess: async (result) => {
      if (!result.ok) toastError(m.integrations_tool_change_error(), new Error(result.error));
      await refresh();
    },
    onError: (error) => toastError(m.integrations_tool_change_error(), error),
  });
  const { listings } = row;
  const checked = listings?.checkedAt
    ? m.integrations_admin_checked({ time: absoluteLabel(new Date(listings.checkedAt)) })
    : null;
  // Shown with tools too: one account failing says nothing about the others.
  const failing = listings?.failing
    ? m.integrations_admin_failing({ count: listings.failing, error: listings.error ?? "" })
    : null;

  return (
    <Section
      title={m.integrations_admin_tools_title()}
      description={
        listings ? m.integrations_admin_tools_listed() : m.integrations_admin_tools_static()
      }
      actions={
        listings ? (
          <PendingButton
            size="sm"
            variant="outline"
            pending={check.isPending}
            onClick={() => check.mutate()}
          >
            <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />
            {m.integrations_admin_check_now()}
          </PendingButton>
        ) : null
      }
    >
      {row.tools.length === 0 ? (
        <EmptyState
          icon={PlugSocketIcon}
          title={m.integrations_detail_no_tools()}
          description={failing ?? m.integrations_admin_no_tools_hint()}
        />
      ) : (
        <ListCard>
          {row.tools.map((tool) => (
            <ListRow key={tool.name} className="items-start">
              <Switch
                checked={!tool.off && !tool.unsupported}
                disabled={Boolean(tool.unsupported) || set.isPending}
                aria-label={m.integrations_admin_offer_tool({
                  tool: toolText(row.kind, tool).title,
                })}
                onCheckedChange={(on) => set.mutate({ tool, off: !on, access: tool.access })}
              />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-sm font-medium">
                  {toolText(row.kind, tool).title}
                </span>
                {tool.unsupported || tool.pastLimit ? (
                  <span className="text-muted-foreground text-xs">
                    {tool.unsupported ??
                      m.integrations_admin_tool_limit({ count: MCP_LIMITS.enabledTools })}
                  </span>
                ) : tool.description ? (
                  <ToolDescription text={tool.description} />
                ) : null}
                {tool.access === tool.claimed ? null : (
                  <span className="text-muted-foreground text-xs">{CLAIMS[tool.claimed]()}</span>
                )}
              </div>
              <Select
                value={tool.access}
                items={accessChoices()}
                disabled={Boolean(tool.unsupported) || set.isPending}
                onValueChange={(access) =>
                  set.mutate({ tool, off: tool.off, access: access as ToolAccess })
                }
              >
                <SelectTrigger
                  size="sm"
                  aria-label={m.integrations_tool_access_label({
                    tool: toolText(row.kind, tool).title,
                  })}
                  className="w-40"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {accessChoices().map((choice) => (
                    <SelectItem key={choice.value} value={choice.value}>
                      {choice.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </ListRow>
          ))}
        </ListCard>
      )}
      {row.tools.length && failing ? <FieldError>{failing}</FieldError> : null}
      {checked ? <p className="text-muted-foreground text-xs">{checked}</p> : null}
    </Section>
  );
}

/** Two lines until clicked: a server's descriptions run long, and the admin may want all of one. */
function ToolDescription({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      aria-expanded={open}
      className={cn(
        "text-muted-foreground text-left text-xs whitespace-pre-line",
        !open && "line-clamp-2",
      )}
      onClick={() => setOpen((current) => !current)}
    >
      {text}
    </button>
  );
}
