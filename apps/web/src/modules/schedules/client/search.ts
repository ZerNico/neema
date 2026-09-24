import { Calendar03Icon } from "@hugeicons/core-free-icons";
import { listSource } from "~/modules/search/registry.ts";
import { schedulesQuery } from "./queries.ts";

export const useScheduleSearch = listSource({
  heading: "Schedules",
  icon: Calendar03Icon,
  query: schedulesQuery,
  allowed: (capabilities) => capabilities.schedules,
  text: (schedule) => schedule.scheduleText,
  detail: (schedule) => schedule.scheduleText,
  href: (schedule) => `/schedules/${schedule.id}`,
});
