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
import type { IntegrationGrant } from "~/modules/integrations/grant.ts";
import { parseMailbox } from "~/modules/integrations/mailbox.ts";
import { accountUsability } from "~/modules/integrations/server/credentials.ts";
import { integrationUsableBy } from "~/modules/integrations/server/repo.ts";
import type { AgentRepo } from "~/modules/agents/server/repo.ts";
import type { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import type { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { ScheduleRejected, ScheduleSettings, type ScheduleNotify } from "../schema.ts";
import { isValidTimezone, nextFireAt, validateCron } from "./cron.ts";
import type { DbTx } from "~/server/db.ts";

export type ValidatedSchedule = Omit<
  ScheduleSettings,
  "endAt" | "collectionIds" | "skillIds" | "chatMode" | "chatId" | "integrationGrants" | "notify"
> & {
  /** Absent keeps what is saved, or the column default on a new schedule. */
  notify?: ScheduleNotify;
  /** Absent keeps what is saved; see ScheduleSettings. */
  integrationGrants?: IntegrationGrant[];
  endAt: Date | null;
  collectionIds: string[];
  skillIds: string[];
  chatMode: "new" | "same";
  /** Always null in `new` mode, so a stale pick never lingers on the row. */
  chatId: string | null;
};

/**
 * A grant's allowances in the form they are compared: write access, and at
 * least one exact address each, as the mailbox parser writes it. Whether the
 * integration's type declares them is checked with the integration itself,
 * in `checkScheduleResources`. Returns the reason otherwise.
 */
export const normalizeGrant = (grant: IntegrationGrant): IntegrationGrant | string => {
  const entries = Object.entries(grant.allowances ?? {});
  const named = {
    connectionId: grant.connectionId,
    integrationId: grant.integrationId,
    access: grant.access,
  };
  if (entries.length === 0) return named;
  if (grant.access !== "write") return "only read-and-write access can let runs contact people";
  const allowances: Record<string, { targets: string[] }> = {};
  for (const [id, entry] of entries) {
    const targets = entry.targets.map(parseMailbox);
    if (targets.some((target) => target === null))
      return `“${entry.targets[targets.indexOf(null)]}” is not a plain email address`;
    const unique = [...new Set(targets as string[])];
    if (unique.length === 0) return "add at least one address to each allowance";
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
    Effect.mapError(() => new ScheduleRejected({ reason: "invalid schedule settings" })),
  );
  if (!settings.name.trim())
    return yield* new ScheduleRejected({ reason: "name must not be blank" });
  if (!settings.prompt.trim())
    return yield* new ScheduleRejected({ reason: "prompt must not be blank" });
  const cronIssue = validateCron(settings.cron, settings.timezone);
  if (cronIssue) return yield* new ScheduleRejected({ reason: `invalid schedule: ${cronIssue}` });
  if (!isValidTimezone(settings.timezone))
    return yield* new ScheduleRejected({ reason: "unknown timezone" });
  const endAt = settings.endAt ? new Date(settings.endAt) : null;
  if (endAt && Number.isNaN(endAt.getTime()))
    return yield* new ScheduleRejected({ reason: "invalid end time" });
  if (settings.modelId) {
    // A usable chat model, as a send requires: a fire would otherwise fall
    // back to the default without saying, and the page would name the wrong one.
    const model = yield* deps.providers.getModel(settings.modelId);
    if (
      !model?.enabled ||
      model.type !== "chat" ||
      !(yield* deps.providers.isModelAccessible(userId, settings.modelId))
    )
      return yield* new ScheduleRejected({ reason: "selected model is unavailable" });
  }
  if (
    settings.imageModelId &&
    !(yield* deps.providers.listImageModelsFor(userId)).some(
      (model) => model.id === settings.imageModelId,
    )
  )
    return yield* new ScheduleRejected({ reason: "selected image model is unavailable" });
  if (settings.searchEnabled && !(yield* deps.policy.can(userId, "webSearch")))
    return yield* new ScheduleRejected({ reason: "web search is not permitted" });
  if (
    settings.researchEnabled &&
    (!(yield* deps.policy.can(userId, "deepResearch")) ||
      !(yield* deps.policy.can(userId, "webSearch")))
  )
    return yield* new ScheduleRejected({ reason: "deep research is not permitted" });
  if (settings.agentId) {
    const agent = yield* deps.agents.get(userId, settings.agentId);
    if (!agent || agent.row.userId !== userId)
      return yield* new ScheduleRejected({ reason: "selected agent is unavailable" });
  }
  const { integrationGrants, ...fields } = settings;
  const grants = integrationGrants?.map(normalizeGrant);
  const invalid = grants?.find((grant) => typeof grant === "string");
  if (invalid) return yield* new ScheduleRejected({ reason: invalid });
  const validated: ValidatedSchedule = {
    ...fields,
    name: settings.name.trim(),
    endAt,
    collectionIds: [...new Set(settings.collectionIds)],
    skillIds: [...new Set(settings.skillIds)],
    chatMode: settings.chatMode ?? "new",
    chatId: settings.chatMode === "same" ? (settings.chatId ?? null) : null,
    ...(grants
      ? {
          integrationGrants: [
            ...new Map(
              grants
                .filter((grant) => typeof grant !== "string")
                .map((grant) => [grant.connectionId, grant]),
            ).values(),
          ],
        }
      : {}),
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
    for (const grant of settings.integrationGrants ?? []) {
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
              ? "an integration this schedule uses is turned off or no longer shared with you"
              : "connect the integration in Settings before letting a schedule use it",
        });
      if (undeclaredAllowance(grant, found!.config.kind))
        return yield* new ScheduleRejected({ reason: "unknown integration allowance" });
    }
    // A chosen chat must be the owner's and a plain chat: a work chat needs
    // the desktop app, which an unattended fire never has, and a temporary one
    // is swept away while the schedule still points at it.
    if (settings.chatId) {
      const [chat] = yield* tx
        .select({ mode: conversations.mode, temporary: conversations.temporary })
        .from(conversations)
        .where(ownedConversationById(settings.chatId, userId))
        .limit(1);
      if (!chat) return yield* new ScheduleRejected({ reason: "the selected chat is unavailable" });
      if (chat.mode !== "chat")
        return yield* new ScheduleRejected({ reason: "a work chat cannot run a schedule" });
      if (chat.temporary)
        return yield* new ScheduleRejected({ reason: "a temporary chat cannot run a schedule" });
    }
    if (settings.skillIds.length) {
      const available = yield* tx
        .select({ id: skills.id })
        .from(skills)
        .where(and(inArray(skills.id, settings.skillIds), readableBy("skill", userId)));
      if (available.length !== settings.skillIds.length)
        return yield* new ScheduleRejected({ reason: "a selected skill is unavailable" });
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
        return yield* new ScheduleRejected({ reason: "a selected collection is unavailable" });
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
