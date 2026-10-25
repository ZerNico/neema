import {
  ArrowRight01Icon,
  BubbleChatIcon,
  Calendar03Icon,
  PencilEdit02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { scheduleAuthoringRequest } from "../authoring.ts";
import { schedulesQuery } from "../client/queries.ts";
import { cadenceLabel, nextFireLabel } from "./schedule-labels.ts";
import { CreateSplitButton } from "~/ui/create-split-button.tsx";
import { EmptyState, ErrorState, ListCard, ListRow, ListSkeleton, Page } from "~/ui/page-shell.tsx";
import { Badge } from "~/ui/primitives/badge";
import { m } from "~/paraglide/messages.js";

export function SchedulesPage() {
  const schedules = useQuery(schedulesQuery);
  const rows = schedules.data ?? [];
  const newSchedule = (
    <CreateSplitButton
      label={m.schedules_list_new()}
      options={[
        {
          label: m.schedules_list_create_with_chat(),
          icon: BubbleChatIcon,
          link: <Link to="/" search={{}} state={{ chatPrefill: scheduleAuthoringRequest() }} />,
        },
        {
          label: m.schedules_list_set_up_manually(),
          icon: PencilEdit02Icon,
          link: <Link to="/schedules/new" />,
        },
      ]}
    />
  );
  return (
    <Page
      title={m.schedules_title()}
      rootPath="/"
      rootLabel={m.schedules_list_root_label()}
      actions={newSchedule}
    >
      {schedules.isError ? (
        <ErrorState
          title={m.schedules_list_load_failed()}
          onRetry={() => {
            void schedules.refetch();
          }}
        />
      ) : schedules.data === undefined ? (
        <ListSkeleton label={m.schedules_list_loading()} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Calendar03Icon}
          title={m.schedules_list_empty_title()}
          description={m.schedules_list_empty_description()}
          action={newSchedule}
        />
      ) : (
        // Whole-row links like Knowledge: pausing, running and deleting live
        // on the schedule's page, one click away.
        <ListCard>
          {rows.map((schedule) => (
            <Link
              key={schedule.id}
              to="/schedules/$scheduleId"
              params={{ scheduleId: schedule.id }}
              aria-label={m.schedules_list_open({ name: schedule.name })}
              className="block"
            >
              <ListRow interactive>
                <div className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-2xl">
                  <HugeiconsIcon icon={Calendar03Icon} strokeWidth={2} className="size-4" />
                </div>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <span className="truncate">{schedule.name}</span>
                    {schedule.paused ? (
                      <Badge variant="outline">{m.schedules_status_paused()}</Badge>
                    ) : null}
                  </span>
                  <span className="text-muted-foreground truncate text-xs">
                    {[cadenceLabel(schedule), nextFireLabel(schedule)].filter(Boolean).join(" · ")}
                  </span>
                </div>
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  strokeWidth={2}
                  className="text-muted-foreground size-4 shrink-0"
                />
              </ListRow>
            </Link>
          ))}
        </ListCard>
      )}
    </Page>
  );
}
