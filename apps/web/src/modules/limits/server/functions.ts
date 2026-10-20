import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { requireAdmin, requireSession } from "~/modules/auth/server/middleware.ts";
import { runServerFn } from "~/server/run-server-fn.ts";
import { LimitIdInput, SaveLimitInput, TimeZoneInput } from "../schema.ts";
import { UsageLimits } from "./service.ts";

const standard = Schema.toStandardSchemaV1;

/** The limits the signed-in person is held to, with what is used of each. */
export const getMyLimits = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .handler(({ context }) =>
    runServerFn(UsageLimits.use((limits) => limits.standing(context.session.user.id))),
  );

/** Every rule, everyone's and each group's, with the time zone periods begin in. */
export const getUsageLimitRules = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(() =>
    runServerFn(
      UsageLimits.use((limits) =>
        Effect.all({ rules: limits.rules(), timeZone: limits.timeZone() }),
      ),
    ),
  );

export const saveUsageLimit = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(SaveLimitInput))
  .handler(({ data }) => runServerFn(UsageLimits.use((limits) => limits.saveRule(data))));

export const deleteUsageLimit = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(LimitIdInput))
  .handler(({ data }) => runServerFn(UsageLimits.use((limits) => limits.deleteRule(data.id))));

export const setLimitTimeZone = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(TimeZoneInput))
  .handler(({ data }) =>
    runServerFn(UsageLimits.use((limits) => limits.setTimeZone(data.timeZone))),
  );
