/**
 * Opt-in checks against real services; every run costs real (small) requests.
 *
 *   MODEL_CLIENT_LIVE='[{"preset":"openai","model":"gpt-5.4-mini","key":"OPENAI_KEY","reasoning":true}]' \
 *     OPENAI_KEY=sk-... node packages/model-client/scripts/live-check.ts
 *
 * `key` names the environment variable holding the key, so keys never sit in
 * the target list; `aws` names the two holding an access key id and secret
 * instead, with `settings: {"auth":"aws"}`. Per target: one short reply, one tool round with its
 * continuation, and one repeated long prompt to see cache reads.
 */
import { Effect, Layer, Schema, Stream } from "effect";
import { LanguageModel, Prompt, type Response, Tool, Toolkit } from "effect/ai";
import { FetchHttpClient } from "effect/http";
import { makeConnection } from "../src/connection.ts";
import { layer } from "../src/language-model.ts";
import type { PresetId, ProviderSettings } from "../src/preset.ts";
import { replayOf, roundPrompt } from "../src/replay.ts";

interface Target {
  preset: PresetId;
  model: string;
  key?: string;
  aws?: [idVariable: string, secretVariable: string];
  baseUrl?: string;
  settings?: ProviderSettings;
  reasoning?: boolean;
  effort?: string;
  label?: string;
}

const targets = JSON.parse(process.env["MODEL_CLIENT_LIVE"] ?? "[]") as Target[];
if (targets.length === 0) {
  console.error("Set MODEL_CLIENT_LIVE to a JSON list of targets; see the header.");
  process.exit(1);
}

const weather = Tool.make("get_weather", {
  description: "Current weather for a city",
  parameters: Schema.Struct({ city: Schema.String }),
  success: Schema.Struct({ tempC: Schema.Number, sky: Schema.String }),
});
const kit = Toolkit.make(weather);
const toolkit = kit.pipe(
  Effect.provide(kit.toLayer({ get_weather: () => Effect.succeed({ tempC: 21, sky: "clear" }) })),
);

const summarize = (parts: ReadonlyArray<Response.AnyPart>) => {
  const text = parts.flatMap((part) => (part.type === "text-delta" ? [part.delta] : [])).join("");
  const reasoning = parts
    .flatMap((part) => (part.type === "reasoning-delta" ? [part.delta] : []))
    .join("");
  const finish = parts.find((part) => part.type === "finish");
  const unit = finish ? replayOf(finish.metadata) : undefined;
  return {
    text: text.slice(0, 80),
    reasoningChars: reasoning.length,
    calls: parts.filter((part) => part.type === "tool-call").map((part) => part.name),
    finish: finish?.reason,
    usage: finish?.usage
      ? {
          input: finish.usage.inputTokens.total,
          cacheRead: finish.usage.inputTokens.cacheRead,
          cacheWrite: finish.usage.inputTokens.cacheWrite,
          output: finish.usage.outputTokens.total,
          reasoning: finish.usage.outputTokens.reasoning,
        }
      : undefined,
    cost: (finish?.metadata["modelClient"] as { cost?: number } | undefined)?.cost,
    replay: unit
      ? unit.format === "responses"
        ? `${unit.items.length} items`
        : unit.format === "messages"
          ? `${unit.blocks.length} blocks`
          : Object.keys(unit).filter((key) => !["v", "id", "identity", "format"].includes(key))
      : "none",
  };
};

const LONG_SYSTEM = `You are a careful assistant. ${"Follow the house style guide exactly. ".repeat(Number(process.env["MODEL_CLIENT_LIVE_CACHE_REPEAT"] ?? 260))}`;

const check = (target: Target) =>
  Effect.gen(function* () {
    const connection = makeConnection({
      provider: "live",
      preset: target.preset,
      baseUrl: target.baseUrl ?? null,
      credentials: target.aws
        ? {
            kind: "aws",
            accessKeyId: process.env[target.aws[0]] ?? "",
            secretAccessKey: process.env[target.aws[1]] ?? "",
          }
        : target.key && process.env[target.key]
          ? { kind: "key", key: process.env[target.key]! }
          : null,
      settings: target.settings ?? null,
    });
    if (!connection) return yield* Effect.fail(new Error("no base URL"));
    const model = layer(connection, {
      model: target.model,
      capabilities: { reasoning: target.reasoning === true, tools: true },
      reasoningEffort: target.effort ?? null,
      maxOutputTokens: 2000,
      cacheKey: "live-check",
    }).pipe(Layer.provide(FetchHttpClient.layer));
    const run = (prompt: Prompt.Prompt, withTools: boolean) =>
      Effect.gen(function* () {
        const tools = yield* toolkit;
        return yield* (
          withTools
            ? LanguageModel.streamText({ prompt, toolkit: tools })
            : LanguageModel.streamText({ prompt })
        ).pipe(
          Stream.runCollect,
          Effect.map((parts) => Array.from(parts)),
        );
      }).pipe(Effect.provide(model));

    const short = yield* run(Prompt.make("Reply with the single word OK."), false);
    const question = Prompt.make(
      "What is the weather in Berlin right now? Use the tool, then answer in one sentence.",
    );
    const round = yield* run(question, true);
    const answer = yield* run(Prompt.concat(question, roundPrompt(round)), true);
    const cached = Prompt.make([
      { role: "system", content: LONG_SYSTEM, options: { cache: { anchor: true } } },
      { role: "user", content: "Say hi." },
    ]);
    yield* run(cached, false);
    const second = yield* run(cached, false);
    return {
      short: summarize(short),
      toolRound: summarize(round),
      continuation: summarize(answer),
      cacheRepeat: summarize(second).usage,
    };
  });

for (const target of targets) {
  const label = target.label ?? `${target.preset} ${target.model}`;
  const result = await Effect.runPromise(
    check(target).pipe(
      Effect.map((value) => ({ ok: true as const, value })),
      Effect.catchCause((cause) =>
        Effect.succeed({ ok: false as const, error: String(cause).slice(0, 600) }),
      ),
    ),
  );
  console.log(`\n=== ${label}`);
  console.log(JSON.stringify(result, null, 1));
}
