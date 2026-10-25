import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { mcpResource } from "~/modules/auth/server/auth.ts";
import { requireOwnSession, requireSession } from "~/modules/auth/server/middleware.ts";
import { apiKeysAllowed } from "~/modules/mcp-server/server/access.ts";
import { localized } from "~/i18n/localized.ts";
import { m } from "~/paraglide/messages.js";
import { refusal } from "~/server/refusal.ts";
import { runServerFn } from "~/server/run-server-fn.ts";
import { MAX_API_KEYS, NewApiKey } from "../schema.ts";
import { ApiKeys } from "./service.ts";

const standard = Schema.toStandardSchemaV1;

const mayUseApiKeys = (userId: string) => runServerFn(apiKeysAllowed(userId));

export const listApiKeys = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .handler(async ({ context }) => {
    const userId = context.session.user.id;
    const [keys, allowed] = await Promise.all([
      runServerFn(ApiKeys.use((service) => service.list(userId))),
      mayUseApiKeys(userId),
    ]);
    return { keys, allowed, serverUrl: mcpResource() ?? null };
  });

export const createApiKey = createServerFn({ method: "POST" })
  .middleware([requireOwnSession])
  .validator(standard(NewApiKey))
  .handler(async ({ data, context }) => {
    const { user } = context.session;
    if (!(await mayUseApiKeys(user.id)))
      throw refusal(403, localized(m.api_keys_error_not_allowed));
    const created = await runServerFn(
      ApiKeys.use((keys) => keys.create(user.id, data)).pipe(
        Effect.catchTag("ApiKeyLimitReached", () => Effect.succeed(null)),
      ),
    );
    if (!created) throw refusal(409, localized(m.api_keys_error_limit, { count: MAX_API_KEYS }));
    return created;
  });

export const revokeApiKey = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(Schema.Struct({ id: Schema.String })))
  .handler(({ data, context }) =>
    runServerFn(
      ApiKeys.use((keys) => keys.revoke(context.session.user.id, data.id)).pipe(
        Effect.as({ ok: true as const }),
      ),
    ),
  );
