import { and, eq, inArray, sql } from "drizzle-orm";
import { readableBy } from "~/modules/sharing/server/resources.ts";
import { Effect, Schema } from "effect";
import {
  conversations,
  integrationConfigs,
  integrationConnections,
  knowledgeCollections,
  skills,
} from "~/db/schema/index.ts";
import { ownedConversationById } from "~/modules/chat/server/owned-conversation.ts";
import { findIntegrationType } from "~/modules/integrations/catalog.ts";
import type { IntegrationGrant, ScheduleGrant } from "~/modules/integrations/grant.ts";
import { parseMailbox } from "~/modules/integrations/mailbox.ts";
import { accountUsability } from "~/modules/integrations/server/credentials.ts";
import { integrationUsableBy } from "~/modules/integrations/server/repo.ts";
import type { AgentRepo } from "~/modules/agents/server/repo.ts";
import type { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import type { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { ScheduleRejected, ScheduleSettings } from "../schema.ts";
import { cadenceIssue, nextFireAt } from "./cron.ts";
import type { DbTx } from "~/server/db.ts";
import { type Localized, localized } from "~/i18n/localized.ts";
import { m } from "~/paraglide/messages.js";

export type ValidatedSchedule = Omit<
  ScheduleSettings,
  "endAt" | "collectionIds" | "skillIds" | "integrationGrants"
> & {
  integrationGrants: IntegrationGrant[];
  endAt: Date | null;
  collectionIds: string[];
  skillIds: string[];
};

/**
 * A grant's allowances in the form they are compared: write access, and at
 * least one exact address each, as the mailbox parser writes it. Whether the
 * integration's type declares them is checked with the integration itself,
 * in `checkScheduleResources`. Returns the reason otherwise, also for a
 * grant whose account is gone.
 */
export const normalizeGrant = (grant: ScheduleGrant): IntegrationGrant | Localized => {
  // Kept on the schedule so the editor shows it; never saved again.
  if (grant.integrationId === null) return localized(m.schedules_error_grant_integration_deleted);
  if (grant.connectionId === null) return localized(m.schedules_error_grant_account_disconnected);
  const entries = Object.entries(grant.allowances ?? {});
  const named = {
    connectionId: grant.connectionId,
    integrationId: grant.integrationId,
    access: grant.access,
  };
  if (entries.length === 0) return named;
  if (grant.access !== "write") return localized(m.schedules_error_grant_needs_write);
  const allowances: Record<string, { targets: string[] }> = {};
  for (const [id, entry] of entries) {
    const targets = entry.targets.map(parseMailbox);
    if (targets.some((target) => target === null))
      return localized(m.schedules_error_grant_not_plain, {
        address: entry.targets[targets.indexOf(null)]!,
      });
    const unique = [...new Set(targets as string[])];
    if (unique.length === 0) return localized(m.schedules_error_grant_no_address);
    allowances[id] = { targets: unique };
  }
  return { ...named, allowances };
};

/** An allowance the grant names that its integration's type does not declare, if any. */
export const undeclaredAllowance = (grant: IntegrationGrant, kind: string) => {
  const declared = findIntegrationType(kind)?.allowances ?? [];
  return (
    Object.keys(grant.allowances ?? {}).find(
      (id) => !declared.some((allowance) => allowance.id === id),
    ) ?? null
  );
};

/**
 * What the detail page and the draft's Save both apply before a schedule row
 * is written: shape, cadence, and the model/agent selections. Collections and
 * skills are checked separately on the writing transaction.
 */
export const validateScheduleSettings = Effect.fn("schedules.validateSettings")(function* (
  deps: {
    providers: ProviderRepo["Service"];
    agents: AgentRepo["Service"];
    policy: FeaturePolicy["Service"];
  },
  userId: string,
  raw: unknown,
) {
  const settings = yield* Schema.decodeUnknownEffect(ScheduleSettings)(raw).pipe(
    Effect.mapError(
      () => new ScheduleRejected({ reason: localized(m.schedules_error_invalid_settings) }),
    ),
  );
  if (!settings.name.trim())
    return yield* new ScheduleRejected({ reason: localized(m.schedules_error_name_blank) });
  if (!settings.prompt.trim())
    return yield* new ScheduleRejected({ reason: localized(m.schedules_error_prompt_blank) });
  const cadence = cadenceIssue(settings);
  if (cadence) return yield* new ScheduleRejected({ reason: cadence });
  const endAt = settings.endAt ? new Date(settings.endAt) : null;
  if (settings.modelId) {
    // A usable chat model, as a send requires: a fire would otherwise fall
    // back to the default without saying, and the page would name the wrong one.
    if (!(yield* deps.providers.usableModel(userId, settings.modelId, "chat")))
      return yield* new ScheduleRejected({
        reason: localized(m.schedules_error_model_unavailable),
      });
  }
  if (
    settings.imageModelId &&
    !(yield* deps.providers.usableModel(userId, settings.imageModelId, "image"))
  )
    return yield* new ScheduleRejected({
      reason: localized(m.schedules_error_image_model_unavailable),
    });
  if (settings.searchEnabled && !(yield* deps.policy.can(userId, "webSearch")))
    return yield* new ScheduleRejected({
      reason: localized(m.schedules_error_search_not_permitted),
    });
  if (
    settings.researchEnabled &&
    (!(yield* deps.policy.can(userId, "deepResearch")) ||
      !(yield* deps.policy.can(userId, "webSearch")))
  )
    return yield* new ScheduleRejected({
      reason: localized(m.schedules_error_research_not_permitted),
    });
  if (settings.agentId) {
    const agent = yield* deps.agents.get(userId, settings.agentId);
    if (!agent || agent.row.userId !== userId)
      return yield* new ScheduleRejected({
        reason: localized(m.schedules_error_agent_unavailable),
      });
  }
  const { integrationGrants, ...fields } = settings;
  const grants = integrationGrants.map(normalizeGrant);
  const invalid = grants.find((grant) => typeof grant === "function");
  if (invalid) return yield* new ScheduleRejected({ reason: invalid });
  const validated: ValidatedSchedule = {
    ...fields,
    name: settings.name.trim(),
    endAt,
    collectionIds: [...new Set(settings.collectionIds)],
    skillIds: [...new Set(settings.skillIds)],
    // Always null in `new` mode, so a stale pick never lingers on the row.
    chatId: settings.chatMode === "same" ? settings.chatId : null,
    integrationGrants: [
      ...new Map(
        grants
          .filter((grant) => typeof grant !== "function")
          .map((grant) => [grant.connectionId, grant]),
      ).values(),
    ],
  };
  return validated;
});

/** Runs on the writing transaction so a revoked resource rolls the write back. */
export const checkScheduleResources = (
  tx: DbTx,
  userId: string,
  settings: Pick<ValidatedSchedule, "skillIds" | "collectionIds" | "chatId" | "integrationGrants">,
) =>
  Effect.gen(function* () {
    // A grant needs a working account of the person's own now, on the
    // integration it names, the way a collection needs to be readable; a fire
    // rechecks it.
    for (const grant of settings.integrationGrants) {
      const [found] = yield* tx
        .select({
          connection: integrationConnections,
          config: integrationConfigs,
          access: sql<boolean>`${integrationUsableBy(userId)}`,
        })
        .from(integrationConnections)
        .innerJoin(
          integrationConfigs,
          eq(integrationConfigs.id, integrationConnections.integrationId),
        )
        .where(
          and(
            eq(integrationConnections.id, grant.connectionId),
            eq(integrationConnections.userId, userId),
            eq(integrationConnections.integrationId, grant.integrationId),
          ),
        )
        .limit(1);
      const state = found
        ? accountUsability(found.config, Boolean(found.access), found.connection)
        : null;
      if (!state?.usable)
        return yield* new ScheduleRejected({
          reason:
            state?.reason === "unavailable"
              ? localized(m.schedules_error_integration_unavailable)
              : localized(m.schedules_error_integration_not_connected),
        });
      if (undeclaredAllowance(grant, found!.config.kind))
        return yield* new ScheduleRejected({
          reason: localized(m.schedules_error_unknown_allowance),
        });
    }
    // A chosen chat must be the owner's and kept: a temporary one is swept
    // away while the schedule still points at it.
    if (settings.chatId) {
      const [chat] = yield* tx
        .select({ temporary: conversations.temporary })
        .from(conversations)
        .where(ownedConversationById(settings.chatId, userId))
        .limit(1);
      if (!chat)
        return yield* new ScheduleRejected({
          reason: localized(m.schedules_error_chat_unavailable),
        });
      if (chat.temporary)
        return yield* new ScheduleRejected({
          reason: localized(m.schedules_error_temporary_chat),
        });
    }
    if (settings.skillIds.length) {
      const available = yield* tx
        .select({ id: skills.id })
        .from(skills)
        .where(and(inArray(skills.id, settings.skillIds), readableBy("skill", userId)));
      if (available.length !== settings.skillIds.length)
        return yield* new ScheduleRejected({
          reason: localized(m.schedules_error_skill_unavailable),
        });
    }
    if (settings.collectionIds.length) {
      const available = yield* tx
        .select({ id: knowledgeCollections.id })
        .from(knowledgeCollections)
        .where(
          and(
            inArray(knowledgeCollections.id, settings.collectionIds),
            readableBy("collection", userId),
          ),
        );
      if (available.length !== settings.collectionIds.length)
        return yield* new ScheduleRejected({
          reason: localized(m.schedules_error_collection_unavailable),
        });
    }
  });

/** First fire after now, or null once the cadence is past `endAt`. */
export const firstFireAt = (
  settings: { cron: string; timezone: string; endAt: Date | null },
  from: Date = new Date(),
): Date | null => {
  const next = nextFireAt(settings.cron, settings.timezone, from);
  if (!next || (settings.endAt && next > settings.endAt)) return null;
  return next;
};
