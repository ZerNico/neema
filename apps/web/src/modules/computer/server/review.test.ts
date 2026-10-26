import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import type { Response } from "effect/ai";
import { AnalyticsRepo } from "~/modules/analytics/server/repo.ts";
import { LanguageRepo } from "~/modules/language/server/repo.ts";
import { AiGateway, ProviderUnreachable } from "~/modules/providers/server/gateway.ts";
import { ProviderRepo, type ModelRow } from "~/modules/providers/server/repo.ts";
import { CommandReviewer, parseVerdict, reviewPrompt, type ReviewInput } from "./review.ts";

const input: ReviewInput = {
  userId: "u",
  conversationId: "c",
  modelId: "chat-model",
  name: "run_command",
  args: { command: "git push --force" },
  folders: [{ name: "site", readOnly: false }],
};

const usage = { inputTokens: {}, outputTokens: {} } as Response.Usage;

/** The reviewer over fakes: which models exist, what the provider answers, what was asked. */
const reviewer = (options: {
  readonly reviewModelId?: string | null;
  readonly models?: Record<string, { enabled: boolean }>;
  readonly answer?: Effect.Effect<string, ProviderUnreachable>;
}) => {
  const asked: string[] = [];
  const generateText: AiGateway["Service"]["generateText"] = (request) => {
    asked.push(request.modelId);
    return Effect.map(options.answer ?? Effect.succeed("RUN"), (text) => ({
      text,
      usage,
      finishMetadata: undefined,
    }));
  };
  const layer = CommandReviewer.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(AiGateway, AiGateway.of({ generateText } as AiGateway["Service"])),
        Layer.succeed(
          ProviderRepo,
          ProviderRepo.of({
            getReviewModelId: () => Effect.succeed(options.reviewModelId ?? null),
            getModel: (id: string) =>
              Effect.succeed(
                options.models?.[id]
                  ? ({
                      id,
                      type: "chat",
                      displayName: id,
                      enabled: options.models[id].enabled,
                    } as ModelRow)
                  : null,
              ),
          } as ProviderRepo["Service"]),
        ),
        Layer.succeed(AnalyticsRepo, AnalyticsRepo.of({ record: () => Effect.void } as never)),
        Layer.succeed(
          LanguageRepo,
          LanguageRepo.of({ localeOf: () => Effect.succeed("de") } as never),
        ),
      ),
    ),
  );
  return {
    asked,
    run: Effect.flatMap(CommandReviewer, (service) => service.review(input)).pipe(
      Effect.provide(layer),
    ),
  };
};

describe("parseVerdict", () => {
  it("reads RUN, and ASK with the reason the person will see", () => {
    expect(parseVerdict("RUN")).toEqual({ run: true });
    expect(parseVerdict("**RUN**\nroutine")).toEqual({ run: true });
    expect(parseVerdict("ASK: Pushes over the remote history.")).toEqual({
      run: false,
      reason: "Pushes over the remote history.",
    });
  });

  it("asks without a reason for anything else", () => {
    expect(parseVerdict("Sure, this looks fine to me.")).toEqual({ run: false, reason: null });
    expect(parseVerdict("")).toEqual({ run: false, reason: null });
  });
});

describe("reviewPrompt", () => {
  it("fences the action as data and names the person's folders", () => {
    const text = JSON.stringify(reviewPrompt(input, "German"));
    expect(text).toContain("<action>\\ntool: run_command\\ncommand: git push --force\\n</action>");
    expect(text).toContain("Attached folders: /folders/site");
    expect(text).toContain("in German");
  });
});

describe("CommandReviewer", () => {
  it.effect("reviews with the chat's own model when the admin chose none", () =>
    Effect.gen(function* () {
      const { asked, run } = reviewer({ models: { "chat-model": { enabled: true } } });
      expect(yield* run).toEqual({ run: true });
      expect(asked).toEqual(["chat-model"]);
    }),
  );

  it.effect("uses the admin's model, and asks when that one is unavailable", () =>
    Effect.gen(function* () {
      const chosen = reviewer({
        reviewModelId: "cheap",
        models: { cheap: { enabled: true }, "chat-model": { enabled: true } },
      });
      expect(yield* chosen.run).toEqual({ run: true });
      expect(chosen.asked).toEqual(["cheap"]);

      // Never a quiet fallback to the chat's model: the person is asked.
      const disabled = reviewer({
        reviewModelId: "cheap",
        models: { cheap: { enabled: false }, "chat-model": { enabled: true } },
      });
      expect(yield* disabled.run).toEqual({ run: false, reason: null });
      expect(disabled.asked).toEqual([]);
    }),
  );

  it.effect("asks when the provider fails or breaks", () =>
    Effect.gen(function* () {
      const models = { "chat-model": { enabled: true } };
      expect(
        yield* reviewer({
          models,
          answer: Effect.fail(new ProviderUnreachable({ providerId: "p", message: "down" })),
        }).run,
      ).toEqual({
        run: false,
        reason: null,
      });
      expect(yield* reviewer({ models, answer: Effect.die("broken") }).run).toEqual({
        run: false,
        reason: null,
      });
    }),
  );
});
