import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { ChatService } from "~/modules/chat/server/service.ts";
import { IntegrationNotAvailable } from "~/modules/integrations/errors.ts";
import type { ScheduleGrant } from "~/modules/integrations/grant.ts";
import { IntegrationService } from "~/modules/integrations/server/service.ts";
import { ScheduleFire } from "./fire.ts";
import { ScheduleRepo, type ScheduleRow } from "./repo.ts";
import { ScheduleSettlement } from "./settle.ts";

const row = (integrationGrants: ScheduleGrant[]): ScheduleRow => ({
  id: "schedule",
  userId: "owner",
  name: "Weekly",
  prompt: "Summarize",
  scheduleText: "Every Monday",
  cron: "0 9 * * 1",
  timezone: "UTC",
  endAt: null,
  modelId: null,
  agentId: null,
  imageModelId: null,
  searchEnabled: false,
  researchEnabled: false,
  collectionIds: [],
  skillIds: [],
  chatMode: "new",
  chatId: null,
  paused: false,
  configRevision: 1,
  notify: "always",
  nextFireAt: null,
  lastFiredAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  integrationGrants,
});

// Every grant here fails its check, so a turn is never asked for: the mock has none.
const fireWith = (grants: ScheduleGrant[]) =>
  Effect.runPromise(
    Effect.flatMap(ScheduleFire, (fire) => fire(row(grants), "run")).pipe(
      Effect.provide(
        ScheduleFire.layer.pipe(
          Layer.provide([
            Layer.mock(ChatService, {}),
            Layer.mock(IntegrationService, {
              session: (_userId: string, connectionId: string) =>
                Effect.fail(new IntegrationNotAvailable({ integrationId: null, connectionId })),
              directory: () =>
                Effect.succeed([
                  { id: "outline", kind: "outline", name: "Docs", description: null, server: null },
                ]),
            }),
            Layer.mock(ScheduleRepo, {}),
            Layer.succeed(ScheduleSettlement, { settle: Effect.void }),
          ]),
        ),
      ),
    ),
  );

/** The outcome with its reason worded in `locale`, as the run row stores it. */
const worded = async (grants: ScheduleGrant[], locale: "en" | "de" = "en") => {
  const outcome = await fireWith(grants);
  return "reason" in outcome ? { ...outcome, reason: outcome.reason(locale) } : outcome;
};

describe("a fire's grants", () => {
  it("ends the run with a reason when a granted integration was deleted", async () => {
    expect(await worded([{ connectionId: null, integrationId: null, access: "write" }])).toEqual({
      conversationId: null,
      status: "error",
      reason: "an integration this schedule uses was deleted",
    });
  });

  it("ends the run when a granted account is gone or refused", async () => {
    const gone: ScheduleGrant[] = [
      { connectionId: "gone", integrationId: "outline", access: "read" },
    ];
    expect(await worded(gone)).toEqual({
      conversationId: null,
      status: "error",
      reason: "Docs is not connected or needs reconnecting",
    });
    expect(await worded(gone, "de")).toMatchObject({
      reason: "Docs ist nicht verbunden oder muss neu verbunden werden",
    });
  });
});
