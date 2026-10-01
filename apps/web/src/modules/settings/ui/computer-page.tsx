import { ComputerIcon, Globe02Icon, InternetIcon } from "@hugeicons/core-free-icons";
import { readDesktopNetwork } from "@chat/desktop-rpc";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { useDesktopBrowser } from "~/modules/browser/client/use-desktop-browser.ts";
import { BrowserSearchSetting } from "~/modules/browser/ui/search-engine-setting.tsx";
import { useConfirm } from "~/ui/confirm.tsx";
import { toastError } from "~/ui/error-toast.ts";
import { EmptyState, ListCard, ListRow, Page, Section } from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";

const subscribeToNothing = () => () => {};

/**
 * One list of things allowed on this computer, each removable. Loading, an
 * error and an empty list are rows of the same card, so every section on the
 * page has one shape.
 */
function AllowedList({
  queryKey,
  load,
  remove,
  icon,
  empty,
  confirmRemove,
}: {
  queryKey: readonly string[];
  load: () => Promise<ReadonlyArray<string>>;
  remove: (item: string) => Promise<void>;
  icon: IconSvgElement;
  empty: string;
  confirmRemove: (item: string) => { title: string; description: string };
}) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const items = useQuery({ queryKey, queryFn: load, retry: false, refetchOnMount: "always" });
  const removal = useMutation({
    mutationFn: remove,
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
    onError: (error) => toastError("Couldn’t remove it.", error),
  });
  return (
    <ListCard>
      {items.isPending ? (
        <ListRow className="text-muted-foreground text-sm">Loading…</ListRow>
      ) : items.isError ? (
        <ListRow className="text-muted-foreground text-sm">
          <span role="alert" className="flex-1">
            Couldn’t load this list.
          </span>
          <PendingButton
            variant="ghost"
            size="sm"
            pending={items.isFetching}
            onClick={() => void items.refetch()}
          >
            Try again
          </PendingButton>
        </ListRow>
      ) : items.data.length === 0 ? (
        <ListRow className="text-muted-foreground text-sm">{empty}</ListRow>
      ) : (
        items.data.map((item) => (
          <ListRow key={item}>
            <HugeiconsIcon
              icon={icon}
              strokeWidth={2}
              className="text-muted-foreground size-5 shrink-0"
            />
            <span className="min-w-0 flex-1 wrap-anywhere text-sm font-medium">{item}</span>
            <PendingButton
              variant="ghost"
              size="sm"
              pending={removal.isPending && removal.variables === item}
              onClick={async () => {
                if (await confirm({ ...confirmRemove(item), confirmLabel: "Remove" }))
                  removal.mutate(item);
              }}
            >
              Remove
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
    <Page title="This computer" rootPath="/settings" rootLabel="Settings">
      {!network && !agent ? (
        <EmptyState
          icon={ComputerIcon}
          title="Only in neema Desktop"
          description="What Work may do on a computer is set in neema Desktop on that computer."
        />
      ) : null}
      <BrowserSearchSetting />
      {agent ? (
        <Section
          title="Sites the browser can open"
          description="Work chats open these in the browser without asking. Sites allowed for a single chat aren’t listed."
        >
          <AllowedList
            queryKey={["desktop-browser-sites"]}
            load={() => agent.allowedSites()}
            remove={(site) => agent.revokeSite(site)}
            icon={Globe02Icon}
            empty="No sites yet."
            confirmRemove={(site) => ({
              title: `Remove ${site}?`,
              description: "Work chats will ask before opening it again.",
            })}
          />
        </Section>
      ) : null}
      {network ? (
        <Section
          title="Websites Work can connect to"
          description="When Work runs tasks on this computer, it can reach these sites without asking, for example to download a package."
        >
          <AllowedList
            queryKey={["desktop-network-grants"]}
            load={async () => (await network.list()).map((grant) => grant.host)}
            remove={(host) => network.revoke(host)}
            icon={InternetIcon}
            empty="No websites yet."
            confirmRemove={(host) => ({
              title: `Remove ${host}?`,
              description: "Work will ask before connecting to it again.",
            })}
          />
        </Section>
      ) : null}
    </Page>
  );
}
