import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { requireAdmin, requireSession } from "~/modules/auth/server/middleware.ts";
import { runServerFn } from "~/server/run-server-fn.ts";
import { UsageRangeInput } from "../schema.ts";
import { AnalyticsRepo } from "./repo.ts";
import { previousUsageWindow, resolveUsageWindow, type UsageWindow } from "./range.ts";

const standard = Schema.toStandardSchemaV1;

/**
 * The window travels back to the client so the charts label the days the SQL
 * actually scanned, rather than re-deriving them from a preset and drifting.
 */
const serializeWindow = (window: UsageWindow) => ({
  from: window.from.toISOString(),
  to: window.to.toISOString(),
});

/** Instance-wide usage for the admin dashboard, one round trip. */
export const getUsageAnalytics = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .validator(standard(UsageRangeInput))
  .handler(({ data }) => {
    const window = resolveUsageWindow(data, new Date());
    const previous = previousUsageWindow(window);
    return runServerFn(
      AnalyticsRepo.use((repo) =>
        Effect.all(
          {
            summary: repo.summary(window),
            // Same query, shifted back one window, giving the delta baseline.
            previousSummary: repo.summary(previous),
            daily: repo.daily(window),
            byModel: repo.byModel(window),
            byUser: repo.byUser(window),
          },
          { concurrency: "unbounded" },
        ).pipe(Effect.map((result) => ({ ...result, window: serializeWindow(window) }))),
      ),
    );
  });

/** The signed-in user's own usage; the user id never comes from the client. */
export const getMyUsage = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(standard(UsageRangeInput))
  .handler(({ data, context }) => {
    const userId = context.session.user.id;
    const window = resolveUsageWindow(data, new Date());
    const scope = { ...window, userId };
    const previousScope = { ...previousUsageWindow(window), userId };
    return runServerFn(
      AnalyticsRepo.use((repo) =>
        Effect.all(
          {
            summary: repo.summary(scope),
            previousSummary: repo.summary(previousScope),
            daily: repo.daily(scope),
            byModel: repo.byModel(scope),
          },
          { concurrency: "unbounded" },
        ).pipe(Effect.map((result) => ({ ...result, window: serializeWindow(window) }))),
      ),
    );
  });
