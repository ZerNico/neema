import { Calendar03Icon } from "@hugeicons/core-free-icons";
import { listSource } from "~/modules/search/registry.ts";
import { m } from "~/paraglide/messages.js";
import { schedulesQuery } from "./queries.ts";

export const useScheduleSearch = listSource({
  // A getter, so the heading is read in the page's language when shown.
  get heading() {
    return m.schedules_title();
  },
  icon: Calendar03Icon,
  query: schedulesQuery,
  allowed: (capabilities) => capabilities.schedules,
  text: (schedule) => schedule.scheduleText,
  detail: (schedule) => schedule.scheduleText,
  href: (schedule) => `/schedules/${schedule.id}`,
});
