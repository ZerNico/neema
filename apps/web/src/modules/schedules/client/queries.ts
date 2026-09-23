import { queryOptions } from "@tanstack/react-query";
import { getSchedule, listScheduleRuns, listSchedules } from "../server/functions.ts";

export const schedulesQuery = queryOptions({
  queryKey: ["schedules"],
  queryFn: () => listSchedules(),
  staleTime: 30_000,
});

export const scheduleQuery = (scheduleId: string) =>
  queryOptions({
    queryKey: ["schedule", scheduleId],
    queryFn: () => getSchedule({ data: { scheduleId } }),
    staleTime: 30_000,
  });

export const scheduleRunsQuery = (scheduleId: string, cursor?: { firedAt: string; id: string }) =>
  queryOptions({
    queryKey: ["schedule-runs", scheduleId, cursor ?? null],
    queryFn: () => listScheduleRuns({ data: { scheduleId, ...(cursor ? { cursor } : {}) } }),
    staleTime: 10_000,
  });
