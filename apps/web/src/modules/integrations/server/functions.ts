import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { requireAdmin, requireSession } from "~/modules/auth/server/middleware.ts";
import { publicUrl } from "~/server/public-url.ts";
import { runServerFn } from "~/server/run-server-fn.ts";
import {
  AnswerElicitationInput,
  ApproveCatalogInput,
  BrowseInput,
  ConnectApiKeyInput,
  ConversationIntegrationInput,
  DecideIntegrationCallInput,
  CreateIntegrationInput,
  IntegrationIdInput,
  SaveIntegrationConfigInput,
  SaveKnowledgeSourceInput,
  SourceIdInput,
  UpdateConnectionInput,
} from "../schema.ts";
import { IntegrationApprovals } from "./approvals.ts";
import { callbackPath } from "./oauth.ts";
import { IntegrationService } from "./service.ts";
import { KnowledgeSourceService } from "./sync.ts";

const standard = Schema.toStandardSchemaV1;

/** Expected refusals come back as data the form can show; nothing else does. */
const outcome = <E extends { _tag: string }, R>(effect: Effect.Effect<void, E, R>) =>
  effect.pipe(
    Effect.as({ ok: true as const }),
    Effect.catch((error: E) =>
      Effect.succeed({
        ok: false as const,
        error:
          "reason" in error && typeof error.reason === "string"
            ? error.reason
            : "That integration is not available to you right now.",
      }),
    ),
  );

/** Where callbacks land, for the admin to register with the service. */
export const appOrigin = (request?: Request) =>
  publicUrl() ?? (request ? new URL(request.url).origin : null);

export const listAdminIntegrations = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(async () => {
    const integrations = await runServerFn(
      IntegrationService.use((service) => service.adminList()),
    );
    const origin = appOrigin();
    return {
      integrations: integrations.map((integration) => ({
        ...integration,
        redirectUri: origin ? `${origin}${callbackPath(integration.id)}` : null,
      })),
    };
  });

/** Every integration's id, type and name, so any stored reference can be named and drawn. */
export const listIntegrationDirectory = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .handler(() => runServerFn(IntegrationService.use((service) => service.directory())));

export const createIntegration = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(CreateIntegrationInput))
  .handler(({ data }) =>
    runServerFn(
      IntegrationService.use((service) =>
        service.createIntegration({ kind: data.kind, name: data.name }),
      ).pipe(
        Effect.map((created) => ({ ok: true as const, id: created.id })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, error: error.reason })),
      ),
    ),
  );

export const deleteIntegration = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(IntegrationIdInput))
  .handler(({ data }) =>
    runServerFn(
      outcome(IntegrationService.use((service) => service.deleteIntegration(data.integrationId))),
    ),
  );

export const saveIntegrationConfig = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(SaveIntegrationConfigInput))
  .handler(({ data }) =>
    runServerFn(
      outcome(
        IntegrationService.use((service) =>
          service.saveConfig({
            id: data.integrationId,
            name: data.name,
            enabled: data.enabled,
            config: data.config,
            oauthClientId: data.oauthClientId,
            ...(data.oauthClientSecret === undefined
              ? {}
              : { oauthClientSecret: data.oauthClientSecret }),
            allowApiKeys: data.allowApiKeys,
            ...(data.sharedCredential === undefined
              ? {}
              : { sharedCredential: data.sharedCredential ? { ...data.sharedCredential } : null }),
          }),
        ).pipe(Effect.asVoid),
      ),
    ),
  );

export const listMyIntegrations = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .handler(({ context }) =>
    runServerFn(IntegrationService.use((service) => service.listForUser(context.session.user.id))),
  );

export const connectIntegrationApiKey = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(ConnectApiKeyInput))
  .handler(({ context, data }) =>
    runServerFn(
      outcome(
        IntegrationService.use((service) =>
          service.connectApiKey(context.session.user.id, data.integrationId, data.values),
        ),
      ),
    ),
  );

/** Turns on an integration that needs no account of one's own. */
export const connectIntegrationOpen = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(IntegrationIdInput))
  .handler(({ context, data }) =>
    runServerFn(
      outcome(
        IntegrationService.use((service) =>
          service.connectOpen(context.session.user.id, data.integrationId),
        ),
      ),
    ),
  );

/** Lists a server's tools now, as the admin asking; nothing is offered until approved. */
export const checkIntegrationCatalog = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(IntegrationIdInput))
  .handler(({ context, data }) =>
    runServerFn(
      IntegrationService.use((service) =>
        service.checkCatalog(data.integrationId, context.session.user.id),
      ).pipe(
        Effect.map((catalog) => ({ ok: true as const, catalog })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, error: error.reason })),
      ),
    ),
  );

export const approveIntegrationCatalog = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .validator(standard(ApproveCatalogInput))
  .handler(({ context, data }) =>
    runServerFn(
      IntegrationService.use((service) =>
        service.approveCatalog(context.session.user.id, data.integrationId, {
          version: data.version,
          decisions: data.decisions,
        }),
      ).pipe(
        Effect.map((catalog) => ({ ok: true as const, catalog })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, error: error.reason })),
      ),
    ),
  );

export const updateIntegrationConnection = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(UpdateConnectionInput))
  .handler(({ context, data }) =>
    runServerFn(
      outcome(
        IntegrationService.use((service) =>
          service.updatePreferences(context.session.user.id, data.integrationId, {
            ...(data.offerByDefault === undefined ? {} : { offerByDefault: data.offerByDefault }),
            ...(data.toolPermissions === undefined
              ? {}
              : { toolPermissions: data.toolPermissions }),
            ...(data.scope === undefined ? {} : { scope: data.scope ? [...data.scope] : null }),
          }),
        ),
      ),
    ),
  );

export const disconnectIntegration = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(IntegrationIdInput))
  .handler(({ context, data }) =>
    runServerFn(
      IntegrationService.use((service) =>
        service.disconnect(context.session.user.id, data.integrationId),
      ),
    ),
  );

/** The composer's view: connected integrations and whether this chat offers them. */
export const listChatIntegrations = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(standard(Schema.Struct({ conversationId: Schema.NullOr(Schema.String) })))
  .handler(({ context, data }) =>
    runServerFn(
      IntegrationService.use((service) =>
        service.chatIntegrations(context.session.user.id, data.conversationId),
      ),
    ),
  );

export const setConversationIntegration = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(ConversationIntegrationInput))
  .handler(({ context, data }) =>
    runServerFn(
      outcome(
        IntegrationService.use((service) =>
          service.setConversationIntegration(
            context.session.user.id,
            data.conversationId,
            data.integrationId,
            data.enabled === undefined ? {} : { enabled: data.enabled },
          ),
        ),
      ),
    ),
  );

export const listPendingIntegrationCalls = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .handler(({ context }) =>
    runServerFn(
      IntegrationApprovals.use((approvals) => approvals.pending(context.session.user.id)),
    ),
  );

/** Answers a waiting call. "conversation" also stops asking for that tool in this chat. */
export const decideIntegrationCall = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(DecideIntegrationCallInput))
  .handler(({ context, data }) =>
    runServerFn(
      Effect.gen(function* () {
        const approvals = yield* IntegrationApprovals;
        const userId = context.session.user.id;
        const call = yield* approvals.get(userId, data.callId);
        if (!call) return { ok: false as const };
        // The card never offers this for a destructive call; refuse it anyway.
        if (data.decision === "conversation" && call.access !== "destructive")
          yield* IntegrationService.use((service) =>
            // This one tool, in this chat only; Settings still decides elsewhere.
            service.setConversationIntegration(userId, call.conversationId, call.integrationId, {
              allowTool: call.tool,
            }),
          ).pipe(Effect.ignore);
        const decided = yield* approvals.decide(
          userId,
          data.callId,
          data.decision === "deny" ? "deny" : "allow",
        );
        return { ok: decided };
      }),
    ),
  );

/** Answers a service's question to a running call; the call goes on with the answer. */
export const answerIntegrationElicitation = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(AnswerElicitationInput))
  .handler(({ context, data }) =>
    runServerFn(
      IntegrationApprovals.use((approvals) =>
        approvals.answer(
          context.session.user.id,
          data.callId,
          data.promptId,
          data.action === "accept"
            ? { action: "accept", ...(data.values ? { values: data.values } : {}) }
            : { action: data.action },
        ),
      ).pipe(Effect.map((answered) => ({ ok: answered }))),
    ),
  );

export const listKnowledgeSources = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(standard(Schema.Struct({ collectionId: Schema.String })))
  .handler(({ context, data }) =>
    runServerFn(
      KnowledgeSourceService.use((sources) =>
        sources.list(context.session.user.id, data.collectionId),
      ),
    ),
  );

/** What a connection can be limited to, for its Settings page. */
export const listIntegrationScopeOptions = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(standard(IntegrationIdInput))
  .handler(({ context, data }) =>
    runServerFn(
      IntegrationService.use((service) =>
        service.scopeOptions(context.session.user.id, data.integrationId),
      ).pipe(
        Effect.map((options) => ({ ok: true as const, options })),
        Effect.catch((error) =>
          Effect.succeed({
            ok: false as const,
            error: "reason" in error ? error.reason : "Connect this integration first.",
          }),
        ),
      ),
    ),
  );

/** Children of one node in the service's tree, for the source picker. */
export const browseIntegration = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(standard(BrowseInput))
  .handler(({ context, data }) =>
    runServerFn(
      KnowledgeSourceService.use((sources) =>
        sources.browse(context.session.user.id, data.integrationId, data.parentId ?? null),
      ).pipe(
        Effect.map((nodes) => ({ ok: true as const, nodes })),
        Effect.catch((error) =>
          Effect.succeed({
            ok: false as const,
            error: "reason" in error ? error.reason : "Connect this integration in Settings first.",
          }),
        ),
      ),
    ),
  );

export const saveKnowledgeSource = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(SaveKnowledgeSourceInput))
  .handler(({ context, data }) =>
    runServerFn(
      outcome(
        KnowledgeSourceService.use((sources) => sources.save(context.session.user.id, data)).pipe(
          Effect.asVoid,
        ),
      ),
    ),
  );

export const removeKnowledgeSource = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(SourceIdInput))
  .handler(({ context, data }) =>
    runServerFn(
      KnowledgeSourceService.use((sources) =>
        sources.remove(context.session.user.id, data.sourceId),
      ),
    ),
  );

export const syncKnowledgeSource = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(SourceIdInput))
  .handler(({ context, data }) =>
    runServerFn(
      KnowledgeSourceService.use((sources) =>
        sources.syncNow(context.session.user.id, data.sourceId),
      ),
    ),
  );
