import { useSuspenseQuery } from "@tanstack/react-query";
import { myStorageQuery } from "~/modules/limits/client/queries.ts";
import { formatBytes } from "~/modules/limits/rules.ts";
import { ListCard, ListRow, Page, Section } from "~/ui/page-shell.tsx";
import { Progress } from "~/ui/primitives/progress";

/** What the person stores, against their quota when they have one. */
export function StoragePage() {
  const { data } = useSuspenseQuery(myStorageQuery);
  const label =
    data.quota === null
      ? `${formatBytes(data.used)} used`
      : `${formatBytes(data.used)} of ${formatBytes(data.quota)} used`;
  return (
    <Page title="Storage" rootPath="/settings" rootLabel="Settings">
      <Section
        title="Used"
        description="Files in your chats, projects, collections and skills. A file used in several places counts once."
      >
        <ListCard>
          <ListRow className="flex-col items-stretch gap-2">
            <span className="text-sm font-medium">{label}</span>
            {data.quota === null ? null : (
              <Progress value={Math.min(100, (data.used / data.quota) * 100)} aria-label={label} />
            )}
          </ListRow>
        </ListCard>
      </Section>
    </Page>
  );
}
