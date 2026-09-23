import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { requireSession } from "~/modules/auth/server/middleware.ts";
import { runtime } from "~/server/runtime.ts";
import { ScheduleNotAvailable, ScheduleRejected, ScheduleSettings } from "../schema.ts";
import { ScheduleService } from "./service.ts";

const ScheduleIdInput = Schema.Struct({
  scheduleId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
});
const UpdateScheduleInput = Schema.Struct({
  ...ScheduleIdInput.fields,
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

// Unexpected failures (driver errors can carry SQL or the content being
// written) are logged and replaced by `reportUnexpectedFailures`.
const publicResult = <A, R>(effect: Effect.Effect<A, ScheduleNotAvailable | ScheduleRejected, R>) =>
  effect.pipe(
    Effect.catchTag("ScheduleNotAvailable", () =>
      Effect.die(new Response("Not found", { status: 404 })),
    ),
    Effect.catchTag("ScheduleRejected", (error) =>
      Effect.die(new Response(error.reason, { status: 400 })),
    ),
  );

export const listSchedules = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .handler(({ context }) =>
    runtime.runPromise(
      Effect.flatMap(ScheduleService, (service) => service.list(context.session.user.id)),
    ),
  );
export const getSchedule = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(ScheduleIdInput))
  .handler(({ context, data }) =>
    runtime.runPromise(
      publicResult(
        Effect.flatMap(ScheduleService, (service) =>
          service.get(context.session.user.id, data.scheduleId),
        ),
      ),
    ),
  );
export const listScheduleRuns = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(ListRunsInput))
  .handler(({ context, data }) =>
    runtime.runPromise(
      publicResult(
        Effect.flatMap(ScheduleService, (service) =>
          service.listRuns(
            context.session.user.id,
            data.scheduleId,
            data.cursor
              ? { firedAt: new Date(data.cursor.firedAt), id: data.cursor.id }
              : undefined,
          ),
        ),
      ),
    ),
  );
export const createSchedule = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(ScheduleSettings))
  .handler(({ context, data }) =>
    runtime.runPromise(
      publicResult(
        Effect.flatMap(ScheduleService, (service) => service.create(context.session.user.id, data)),
      ),
    ),
  );
export const updateSchedule = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(UpdateScheduleInput))
  .handler(({ context, data }) =>
    runtime.runPromise(
      publicResult(
        Effect.flatMap(ScheduleService, (service) =>
          service.update(context.session.user.id, data.scheduleId, data.settings),
        ),
      ),
    ),
  );
export const pauseSchedule = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(ScheduleIdInput))
  .handler(({ context, data }) =>
    runtime.runPromise(
      publicResult(
        Effect.flatMap(ScheduleService, (service) =>
          service.pause(context.session.user.id, data.scheduleId),
        ),
      ),
    ),
  );
export const resumeSchedule = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(ScheduleIdInput))
  .handler(({ context, data }) =>
    runtime.runPromise(
      publicResult(
        Effect.flatMap(ScheduleService, (service) =>
          service.resume(context.session.user.id, data.scheduleId),
        ),
      ),
    ),
  );
export const deleteSchedule = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(ScheduleIdInput))
  .handler(({ context, data }) =>
    runtime.runPromise(
      publicResult(
        Effect.flatMap(ScheduleService, (service) =>
          service.remove(context.session.user.id, data.scheduleId),
        ),
      ),
    ),
  );
export const runScheduleNow = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(ScheduleIdInput))
  .handler(({ context, data }) =>
    runtime.runPromise(
      publicResult(
        Effect.flatMap(ScheduleService, (service) =>
          service.runNow(context.session.user.id, data.scheduleId),
        ),
      ),
    ),
  );
export const previewSchedule = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(PreviewInput))
  .handler(({ data }) =>
    runtime.runPromise(
      publicResult(Effect.flatMap(ScheduleService, (service) => service.preview(data))),
    ),
  );
