import { and, eq, inArray } from "drizzle-orm";
import { Effect, Schema } from "effect";
import {
  conversations,
  integrationConfigs,
  integrationConnections,
  knowledgeCollections,
  skills,
} from "~/db/schema/index.ts";
import { integrationUsableBy } from "~/modules/integrations/server/repo.ts";
import type { AgentRepo } from "~/modules/agents/server/repo.ts";
import type { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import type { DbTx } from "~/modules/attachments/server/repo.ts";
import { collectionReadable } from "~/modules/knowledge/server/access.ts";
import type { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { skillReadable } from "~/modules/skills/server/access.ts";
import { ScheduleRejected, ScheduleSettings } from "../schema.ts";
import { isValidTimezone, nextFireAt, validateCron } from "./cron.ts";

export type ValidatedSchedule = Omit<
  ScheduleSettings,
  "endAt" | "collectionIds" | "skillIds" | "chatMode" | "chatId" | "integrationGrants"
> & {
  /** Absent keeps what is saved; see ScheduleSettings. */
  integrationGrants?: Array<{ integrationId: string; access: "read" | "write" }>;
  endAt: Date | null;
  collectionIds: string[];
  skillIds: string[];
  chatMode: "new" | "same";
  /** Always null in `new` mode, so a stale pick never lingers on the row. */
  chatId: string | null;
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
  if (settings.modelId && !(yield* deps.providers.isModelAccessible(userId, settings.modelId)))
    return yield* new ScheduleRejected({ reason: "selected model is unavailable" });
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
  const validated: ValidatedSchedule = {
    ...fields,
    name: settings.name.trim(),
    endAt,
    collectionIds: [...new Set(settings.collectionIds)],
    skillIds: [...new Set(settings.skillIds)],
    chatMode: settings.chatMode ?? "new",
    chatId: settings.chatMode === "same" ? (settings.chatId ?? null) : null,
    ...(integrationGrants
      ? {
          integrationGrants: [
            ...new Map(
              integrationGrants.map((grant) => [grant.integrationId, { ...grant }]),
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
    // A grant needs the person's own working connection now, the way a
    // collection needs to be readable; a fire rechecks it.
    for (const grant of settings.integrationGrants ?? []) {
      const [connection] = yield* tx
        .select({ status: integrationConnections.status })
        .from(integrationConnections)
        .innerJoin(integrationConfigs, eq(integrationConfigs.id, integrationConnections.integrationId))
        .where(
          and(
            eq(integrationConnections.userId, userId),
            eq(integrationConnections.integrationId, grant.integrationId),
            eq(integrationConfigs.enabled, true),
            integrationUsableBy(userId),
          ),
        )
        .limit(1);
      if (connection?.status !== "active")
        return yield* new ScheduleRejected({
          reason: "connect the integration in Settings before letting a schedule use it",
        });
    }
    // A chosen chat must be the owner's and a plain chat: a work chat needs
    // the desktop app, which an unattended fire never has.
    if (settings.chatId) {
      const [chat] = yield* tx
        .select({ mode: conversations.mode })
        .from(conversations)
        .where(and(eq(conversations.id, settings.chatId), eq(conversations.userId, userId)))
        .limit(1);
      if (!chat) return yield* new ScheduleRejected({ reason: "the selected chat is unavailable" });
      if (chat.mode !== "chat")
        return yield* new ScheduleRejected({ reason: "a work chat cannot run a schedule" });
    }
    if (settings.skillIds.length) {
      const available = yield* tx
        .select({ id: skills.id })
        .from(skills)
        .where(and(inArray(skills.id, settings.skillIds), skillReadable(userId)));
      if (available.length !== settings.skillIds.length)
        return yield* new ScheduleRejected({ reason: "a selected skill is unavailable" });
    }
    if (settings.collectionIds.length) {
      const available = yield* tx
        .select({ id: knowledgeCollections.id })
        .from(knowledgeCollections)
        .where(
          and(inArray(knowledgeCollections.id, settings.collectionIds), collectionReadable(userId)),
        );
      if (available.length !== settings.collectionIds.length)
        return yield* new ScheduleRejected({ reason: "a selected collection is unavailable" });
    }
  });

/** First fire after now, or null once the cadence is past `endAt`. */
export const firstFireAt = (settings: {
  cron: string;
  timezone: string;
  endAt: Date | null;
}): Date | null => {
  const next = nextFireAt(settings.cron, settings.timezone, new Date());
  if (!next || (settings.endAt && next > settings.endAt)) return null;
  return next;
};
