import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { requireOwnSession, requireSession } from "~/modules/auth/server/middleware.ts";
import { runServerFn } from "~/server/run-server-fn.ts";
import { ScheduleSettings } from "../schema.ts";
import { ScheduleService } from "./service.ts";
import { EntityId } from "~/entity-id.ts";

const ScheduleIdInput = Schema.Struct({
  scheduleId: EntityId,
});
const UpdateScheduleInput = Schema.Struct({
  ...ScheduleIdInput.fields,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  settings: ScheduleSettings,
});
const ListRunsInput = Schema.Struct({
  ...ScheduleIdInput.fields,
  cursor: Schema.optionalKey(Schema.Struct({ firedAt: Schema.String, id: Schema.String })),
});
const PreviewInput = Schema.Struct({
  cron: ScheduleSettings.fields.cron,
  timezone: ScheduleSettings.fields.timezone,
  endAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

export const listSchedules = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .handler(({ context }) =>
    runServerFn(
      Effect.flatMap(ScheduleService, (service) => service.list(context.session.user.id)),
    ),
  );
export const getSchedule = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(ScheduleIdInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(ScheduleService, (service) =>
        service.get(context.session.user.id, data.scheduleId),
      ),
    ),
  );
export const listScheduleRuns = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(ListRunsInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(ScheduleService, (service) =>
        service.listRuns(
          context.session.user.id,
          data.scheduleId,
          data.cursor ? { firedAt: new Date(data.cursor.firedAt), id: data.cursor.id } : undefined,
        ),
      ),
    ),
  );
/**
 * A schedule keeps firing as its owner long after the session that set it up,
 * so creating, rewriting and resuming one need the person themselves.
 */
export const createSchedule = createServerFn({ method: "POST" })
  .middleware([requireOwnSession])
  .validator(Schema.toStandardSchemaV1(ScheduleSettings))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(ScheduleService, (service) => service.create(context.session.user.id, data)),
    ),
  );
export const updateSchedule = createServerFn({ method: "POST" })
  .middleware([requireOwnSession])
  .validator(Schema.toStandardSchemaV1(UpdateScheduleInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(ScheduleService, (service) =>
        service.update(
          context.session.user.id,
          data.scheduleId,
          data.expectedRevision,
          data.settings,
        ),
      ),
    ),
  );
export const pauseSchedule = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(ScheduleIdInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(ScheduleService, (service) =>
        service.pause(context.session.user.id, data.scheduleId),
      ),
    ),
  );
export const resumeSchedule = createServerFn({ method: "POST" })
  .middleware([requireOwnSession])
  .validator(Schema.toStandardSchemaV1(ScheduleIdInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(ScheduleService, (service) =>
        service.resume(context.session.user.id, data.scheduleId),
      ),
    ),
  );
export const deleteSchedule = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(ScheduleIdInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(ScheduleService, (service) =>
        service.remove(context.session.user.id, data.scheduleId),
      ),
    ),
  );
export const runScheduleNow = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(ScheduleIdInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.flatMap(ScheduleService, (service) =>
        service.runNow(context.session.user.id, data.scheduleId),
      ),
    ),
  );
export const previewSchedule = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(PreviewInput))
  .handler(({ data }) =>
    runServerFn(Effect.flatMap(ScheduleService, (service) => service.preview(data))),
  );
