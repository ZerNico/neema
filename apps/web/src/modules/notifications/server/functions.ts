import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { requireSession } from "~/modules/auth/server/middleware.ts";
import { runtime } from "~/server/runtime.ts";
import { PushService } from "./push.ts";

const Text = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max));
const PushSubscriptionInput = Schema.Struct({
  endpoint: Text(2048),
  p256dh: Text(200),
  auth: Text(100),
  label: Text(200),
});
const EndpointInput = Schema.Struct({ endpoint: Text(2048) });
const DeviceInput = Schema.Struct({ id: Text(128) });

export const getPushKey = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .handler(() => runtime.runPromise(Effect.flatMap(PushService, (push) => push.publicKey)));

export const subscribePush = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(PushSubscriptionInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      Effect.flatMap(PushService, (push) => push.subscribe(context.session.user.id, data)).pipe(
        Effect.catchTag("PushRejected", (error) =>
          Effect.die(new Response(error.reason, { status: 400 })),
        ),
      ),
    ),
  );

export const unsubscribePush = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(EndpointInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      Effect.flatMap(PushService, (push) =>
        push.unsubscribe(context.session.user.id, data.endpoint),
      ),
    ),
  );

export const listPushDevices = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .handler(({ context }) =>
    runtime.runPromise(Effect.flatMap(PushService, (push) => push.list(context.session.user.id))),
  );

export const removePushDevice = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(Schema.toStandardSchemaV1(DeviceInput))
  .handler(({ data, context }) =>
    runtime.runPromise(
      Effect.flatMap(PushService, (push) => push.remove(context.session.user.id, data.id)),
    ),
  );
