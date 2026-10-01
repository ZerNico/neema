import { Globe02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useConfirm } from "~/ui/confirm.tsx";
import { toastError } from "~/ui/error-toast.ts";
import { ListCard, ListRow, Section } from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { useDesktopBrowser } from "../client/use-desktop-browser.ts";

const allowedSitesKey = ["desktop-browser-sites"] as const;

/** Settings › Devices: the sites Work may open in the browser without asking, on this desktop. */
export function AllowedSitesSetting() {
  const agent = useDesktopBrowser()?.agent;
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const sites = useQuery({
    queryKey: allowedSitesKey,
    queryFn: () => agent!.allowedSites(),
    enabled: !!agent,
    retry: false,
    refetchOnMount: "always",
  });
  const revoke = useMutation({
    mutationFn: (site: string) => agent!.revokeSite(site),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: allowedSitesKey }),
    onError: (error) => toastError("Could not remove the site.", error),
  });
  if (!agent) return null;
  return (
    <Section
      title="Allowed sites"
      description="Sites Work may open in the browser on this desktop without asking. Sites allowed for a single chat are not listed."
    >
      {sites.isPending ? (
        <p className="text-muted-foreground text-sm">Loading allowed sites…</p>
      ) : sites.isError ? (
        <div role="alert" className="flex items-center gap-3">
          <span className="text-muted-foreground text-sm">Could not load allowed sites.</span>
          <PendingButton
            variant="outline"
            size="sm"
            pending={sites.isFetching}
            onClick={() => void sites.refetch()}
          >
            Try again
          </PendingButton>
        </div>
      ) : sites.data.length === 0 ? (
        <p className="text-muted-foreground text-sm">No sites allowed everywhere yet.</p>
      ) : (
        <ListCard>
          {sites.data.map((site) => (
            <ListRow key={site}>
              <HugeiconsIcon
                icon={Globe02Icon}
                strokeWidth={2}
                className="text-muted-foreground size-5 shrink-0"
              />
              <span className="min-w-0 flex-1 wrap-anywhere text-sm font-medium">{site}</span>
              <PendingButton
                variant="ghost"
                size="sm"
                pending={revoke.isPending && revoke.variables === site}
                onClick={async () => {
                  if (
                    await confirm({
                      title: `Remove ${site}?`,
                      description: "Work will ask before opening this site again.",
                      confirmLabel: "Remove",
                    })
                  )
                    revoke.mutate(site);
                }}
              >
                Remove
              </PendingButton>
            </ListRow>
          ))}
        </ListCard>
      )}
    </Section>
  );
}
