import { m } from "~/paraglide/messages.js";
import { Route01Icon } from "@hugeicons/core-free-icons";
import { routeSummary } from "~/modules/genui/ui/map-model.ts";
import { cn } from "~/ui/utils";
import type { MapToolActivity } from "../client/use-message-stream.ts";
import { ActivityFace } from "./activity-face.tsx";
import { activityRowClassName } from "./activity-row.ts";

const MODE = { drive: m.chat_map_drive, walk: m.chat_map_walk, bike: m.chat_map_bike } as const;

function mapActivityLabel(activity: MapToolActivity) {
  if (activity.status === "running") return m.chat_map_looking_up();
  const route = activity.route;
  if (!route) return m.chat_map_failed();
  const summary = routeSummary(route);
  return `${MODE[route.mode]()} ${route.stops.join(" → ")}${summary ? ` · ${summary}` : ""}`;
}

/** One line per call: the stops as asked and the totals the model was given. */
export function MapActivityRow({ activity }: { activity: MapToolActivity }) {
  return (
    <div className={cn(activityRowClassName, "mb-2")}>
      <ActivityFace
        icon={Route01Icon}
        label={mapActivityLabel(activity)}
        status={
          activity.status === "running"
            ? "running"
            : activity.status === "error"
              ? "failed"
              : "done"
        }
      />
    </div>
  );
}
