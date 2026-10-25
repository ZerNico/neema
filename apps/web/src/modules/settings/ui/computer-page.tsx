import {
  ComputerIcon,
  FolderShared01Icon,
  Globe02Icon,
  InternetIcon,
} from "@hugeicons/core-free-icons";
import { readDesktopNetwork, type DesktopNetwork, type NetworkGrant } from "@chat/desktop-rpc";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { useDesktopBrowser } from "~/modules/browser/client/use-desktop-browser.ts";
import { BrowserSearchSetting } from "~/modules/browser/ui/search-engine-setting.tsx";
import { useConfirm } from "~/ui/confirm-context.ts";
import { toastError } from "~/ui/error-toast.ts";
import { EmptyState, ListCard, ListRow, Page, Section } from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Badge } from "~/ui/primitives/badge";
import { Switch } from "~/ui/primitives/switch";
import { SshAgentSetting } from "./ssh-agent-setting.tsx";
import { m } from "~/paraglide/messages.js";

const subscribeToNothing = () => () => {};

/** A destination as a person reads it: the host, with its port unless it is HTTPS's. */
export const destinationLabel = ({ host, port }: NetworkGrant) =>
  port === 443 ? host : `${host}:${port}`;

/**
 * One list of things allowed on this computer, each removable. Loading, an
 * error and an empty list are rows of the same card, so every section on the
 * page has one shape.
 */
function AllowedList<T>({
  queryKey,
  load,
  remove,
  label,
  itemKey = label,
  badge,
  icon,
  empty,
  confirmRemove,
}: {
  queryKey: readonly string[];
  load: () => Promise<ReadonlyArray<T>>;
  remove: (item: T) => Promise<void>;
  /** What the row says; also its key unless `itemKey` gives one. */
  label: (item: T) => string;
  itemKey?: (item: T) => string;
  /** A short mark beside the label. */
  badge?: (item: T) => string | null;
  icon: IconSvgElement;
  empty: string;
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
  return (
    <ListCard>
      {items.isPending ? (
        <ListRow className="text-muted-foreground text-sm">{m.settings_computer_loading()}</ListRow>
      ) : items.isError ? (
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
      ) : items.data.length === 0 ? (
        <ListRow className="text-muted-foreground text-sm">{empty}</ListRow>
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
  );
}

/**
 * Settings › This computer: what Work may do on the machine the app runs on.
 * Kept on the machine, never on the server, so it only exists in the desktop
 * app; signed-in devices are an account matter and stay under Devices.
 */
export function ComputerPage() {
  const network = useSyncExternalStore(subscribeToNothing, readDesktopNetwork, () => null);
  const agent = useDesktopBrowser()?.agent;
  return (
    <Page
      title={m.settings_section_computer()}
      rootPath="/settings"
      rootLabel={m.common_settings()}
    >
      {!network && !agent ? (
        <EmptyState
          icon={ComputerIcon}
          title={m.settings_computer_desktop_only_title()}
          description={m.settings_computer_desktop_only_description()}
        />
      ) : null}
      <BrowserSearchSetting />
      {agent ? (
        <Section
          title={m.settings_computer_sites_title()}
          description={m.settings_computer_sites_description()}
        >
          <AllowedList
            queryKey={["desktop-browser-sites"]}
            load={() => agent.allowedSites()}
            remove={(site) => agent.revokeSite(site)}
            label={(site) => site}
            icon={Globe02Icon}
            empty={m.settings_computer_empty()}
            confirmRemove={(site) => ({
              title: m.settings_computer_remove_title({ name: site }),
              description: m.settings_computer_site_remove_description(),
            })}
          />
        </Section>
      ) : null}
      {network ? (
        <Section
          title={m.settings_computer_network_title()}
          description={m.settings_computer_network_description()}
        >
          <AllowedList
            queryKey={["desktop-network-grants"]}
            load={() => network.list()}
            remove={(grant) => network.revoke(grant)}
            label={destinationLabel}
            itemKey={({ host, port, privateNetwork }) => `${host}:${port}:${privateNetwork}`}
            badge={(grant) => (grant.privateNetwork ? m.settings_computer_private_network() : null)}
            icon={InternetIcon}
            empty={m.settings_computer_empty()}
            confirmRemove={(grant) => ({
              title: m.settings_computer_remove_title({ name: destinationLabel(grant) }),
              description: m.settings_computer_network_remove_description(),
            })}
          />
        </Section>
      ) : null}
      {network ? <LocalServicesSetting network={network} /> : null}
      {network ? <SshAgentSetting network={network} /> : null}
      {network ? (
        <Section
          title={m.settings_computer_paths_title()}
          description={m.settings_computer_paths_description()}
        >
          <AllowedList
            queryKey={["desktop-path-grants"]}
            load={() => network.listPaths()}
            remove={(path) => network.revokePath(path)}
            label={(path) => path}
            icon={FolderShared01Icon}
            empty={m.settings_computer_empty()}
            confirmRemove={(path) => ({
              title: m.settings_computer_remove_title({ name: path }),
              description: m.settings_computer_path_remove_description(),
            })}
          />
        </Section>
      ) : null}
    </Page>
  );
}

const LOCAL_KEY = ["desktop-local-grant"] as const;

/**
 * Services on this computer for every chat, as a switch. Turning it on is confirmed here, since
 * a server a command starts could then be reached from the network. Linux commands have their
 * own, so there is nothing to allow there.
 */
function LocalServicesSetting({ network }: { network: DesktopNetwork }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const state = useQuery({
    queryKey: LOCAL_KEY,
    queryFn: () => network.localServices(),
    retry: false,
    refetchOnMount: "always",
  });
  const change = useMutation({
    mutationFn: async (allow: boolean) => {
      if (allow) await network.allowLocal();
      else await network.revokeLocal();
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: LOCAL_KEY }),
    onError: (error) => toastError(m.settings_computer_error_change(), error),
  });
  if (state.data === "unavailable") return null;
  return (
    <Section title={m.settings_computer_local_title()}>
      <ListCard>
        <ListRow>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-sm font-medium">{m.settings_computer_local_allow()}</span>
            <span className="text-muted-foreground text-xs">
              {m.settings_computer_local_hint()}
            </span>
          </div>
          <Switch
            aria-label={m.settings_computer_local_switch()}
            checked={state.data === "allowed"}
            disabled={!state.data || change.isPending}
            onCheckedChange={async (checked) => {
              if (
                checked &&
                !(await confirm({
                  title: m.settings_computer_local_confirm_title(),
                  description: m.settings_computer_local_confirm_description(),
                  confirmLabel: m.settings_computer_local_confirm(),
                }))
              )
                return;
              change.mutate(checked);
            }}
          />
        </ListRow>
      </ListCard>
    </Section>
  );
}
