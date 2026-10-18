import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { mayConnectApps, mcpResource } from "~/modules/auth/server/auth.ts";
import { requireSession } from "~/modules/auth/server/middleware.ts";
import { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import { runtime } from "~/server/runtime.ts";
import { MAX_API_KEYS, NewApiKey } from "../schema.ts";
import { ApiKeys } from "./service.ts";

const standard = Schema.toStandardSchemaV1;

/** A key acts through the MCP endpoint, so it needs both capabilities. */
const mayUseApiKeys = async (userId: string) =>
  (await mayConnectApps(userId)) &&
  runtime.runPromise(Effect.flatMap(FeaturePolicy, (policy) => policy.can(userId, "apiKeys")));

/** A refusal the page shows as is. */
const refuse = (status: number, message: string): never => {
  throw new Response(message, { status });
};

const isImpersonated = (session: object) =>
  "impersonatedBy" in session && Boolean(session.impersonatedBy);

export const listApiKeys = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .handler(async ({ context }) => {
    const userId = context.session.user.id;
    const [keys, allowed] = await Promise.all([
      runtime.runPromise(ApiKeys.use((service) => service.list(userId))),
      mayUseApiKeys(userId),
    ]);
    return { keys, allowed, serverUrl: mcpResource() ?? null };
  });

export const createApiKey = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(NewApiKey))
  .handler(async ({ data, context }) => {
    const { session, user } = context.session;
    // A key outlives the session that made it: nobody makes one as someone else.
    if (isImpersonated(session)) refuse(403, "Stop acting as them before making a key.");
    if (!(await mayUseApiKeys(user.id))) refuse(403, "Your account can’t make API keys.");
    const created = await runtime.runPromise(
      ApiKeys.use((keys) => keys.create(user.id, data)).pipe(
        Effect.catchTag("ApiKeyLimitReached", () => Effect.succeed(null)),
      ),
    );
    if (!created) return refuse(409, `You can have ${MAX_API_KEYS} keys. Revoke one first.`);
    return created;
  });

export const revokeApiKey = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(Schema.Struct({ id: Schema.String })))
  .handler(({ data, context }) =>
    runtime.runPromise(
      ApiKeys.use((keys) => keys.revoke(context.session.user.id, data.id)).pipe(
        Effect.as({ ok: true as const }),
      ),
    ),
  );
