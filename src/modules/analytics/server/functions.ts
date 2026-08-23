import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { requireAdmin, requireSession } from "~/modules/auth/server/middleware.ts";
import { runtime } from "~/server/runtime.ts";
import { UsageRangeInput } from "../schema.ts";
import { AnalyticsRepo } from "./repo.ts";

const standard = Schema.toStandardSchemaV1;

const sinceDaysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

/** Instance-wide usage for the admin dashboard, one round trip. */
export const getUsageAnalytics = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .validator(standard(UsageRangeInput))
  .handler(({ data }) => {
    const since = sinceDaysAgo(data.days);
    return runtime.runPromise(
      AnalyticsRepo.use((repo) =>
        Effect.all(
          {
            summary: repo.summary({ since }),
            daily: repo.daily({ since }),
            byModel: repo.byModel({ since }),
            byUser: repo.byUser({ since }),
          },
          { concurrency: "unbounded" },
        ),
      ),
    );
  });

/** The signed-in user's own usage — the user id never comes from the client. */
export const getMyUsage = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(standard(UsageRangeInput))
  .handler(({ data, context }) => {
    const scope = { since: sinceDaysAgo(data.days), userId: context.session.user.id };
    return runtime.runPromise(
      AnalyticsRepo.use((repo) =>
        Effect.all(
          {
            summary: repo.summary(scope),
            daily: repo.daily(scope),
            byModel: repo.byModel(scope),
          },
          { concurrency: "unbounded" },
        ),
      ),
    );
  });
