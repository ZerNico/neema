import { OpenRouterClient, OpenRouterLanguageModel } from "@effect/ai-openrouter";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Redacted, Schema, Stream } from "effect";
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/unstable/ai";
import { FetchHttpClient } from "effect/unstable/http";
import { responseTurnPrompt } from "./response-prompt.ts";

const image =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const editedImage =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC";
const details = [
  {
    type: "reasoning.text",
    text: null,
    signature: "synthetic-late-signature",
    format: "google-gemini-v1",
    index: 7,
    id: "original-text",
  },
  {
    type: "reasoning.encrypted",
    data: "synthetic-opaque",
    format: "google-gemini-v1",
    index: 2,
    id: "original-image",
  },
] as const;
const chunk = (delta: Record<string, unknown>, finish = false) => ({
  id: "synthetic",
  object: "chat.completion.chunk",
  created: 1756000000,
  model: "synthetic/model",
  choices: [{ index: 0, delta, ...(finish ? { finish_reason: "stop" } : {}) }],
});

describe("pinned OpenRouter image replay contract", () => {
  it.effect(
    "keeps returned edits distinct from replayed images across requests with reused image indexes",
    () =>
      Effect.gen(function* () {
        const requests: Array<{ messages: Array<Record<string, unknown>> }> = [];
        const returnedImages = [image, editedImage, editedImage];
        const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
          const url = returnedImages[requests.length]!;
          requests.push(
            JSON.parse(
              typeof init?.body === "string"
                ? init.body
                : new TextDecoder().decode(init?.body as BufferSource),
            ),
          );
          const events = [
            chunk({ images: [{ index: 0, image_url: { url } }] }),
            {
              ...chunk({}, true),
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            },
          ];
          return new globalThis.Response(
            events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
              "data: [DONE]\n\n",
            {
              headers: { "content-type": "text/event-stream" },
            },
          );
        };
        const layer = OpenRouterLanguageModel.model("synthetic/model", {
          modalities: ["text", "image"],
        }).pipe(
          Layer.provide(
            OpenRouterClient.layer({
              apiKey: Redacted.make("synthetic"),
              apiUrl: "https://mock.invalid/api/v1",
            }),
          ),
          Layer.provide(
            FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
          ),
        );
        let prompt = Prompt.make("Generate a red image");
        for (const [index, nextRequest] of [
          "Make it blue",
          "Make the latest blue image larger",
          "End",
        ].entries()) {
          const parts = yield* LanguageModel.streamText({ prompt }).pipe(
            Stream.runCollect,
            Effect.provide(layer),
          );
          const files = parts.filter((part) => part.type === "file");
          expect(files).toHaveLength(1);
          expect(
            `data:${files[0]!.mediaType};base64,${Buffer.from(files[0]!.data).toString("base64")}`,
          ).toBe(returnedImages[index]);
          prompt = Prompt.concat(
            Prompt.concat(prompt, responseTurnPrompt(parts)),
            Prompt.make(nextRequest),
          );
        }
        const wireImages = (request: (typeof requests)[number]) =>
          request.messages
            .filter((message) => message.role === "assistant")
            .flatMap((message) => message.images);
        expect(wireImages(requests[0]!)).toEqual([]);
        expect(wireImages(requests[1]!)).toEqual([
          { type: "image_url", image_url: { url: image } },
        ]);
        expect(wireImages(requests[2]!)).toEqual([
          { type: "image_url", image_url: { url: image } },
          { type: "image_url", image_url: { url: editedImage } },
        ]);
        expect(requests[1]!.messages.at(-1)).toMatchObject({
          role: "user",
          content: "Make it blue",
        });
        expect(requests[2]!.messages.at(-1)).toMatchObject({
          role: "user",
          content: "Make the latest blue image larger",
        });
      }),
  );
  it.effect(
    "preserves assistant images, text, tools and late opaque metadata through actual HTTP encoding",
    () =>
      Effect.gen(function* () {
        const requests: Array<{ messages: Array<Record<string, unknown>> }> = [];
        const events = [
          chunk({ content: "Before" }),
          chunk({ images: [{ image_url: { url: image } }] }),
          chunk({ content: "After" }),
          chunk({ images: [{ type: "image_url", image_url: { url: editedImage } }] }),
          chunk({ reasoning_details: [details[0]] }),
          chunk({ reasoning_details: [details[1]] }),
          chunk({
            tool_calls: [
              {
                index: 0,
                id: "call-1",
                type: "function",
                function: { name: "inspect_image", arguments: "{}" },
              },
            ],
          }),
          {
            ...chunk({}, true),
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        ];
        const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
          requests.push(
            JSON.parse(
              typeof init?.body === "string"
                ? init.body
                : new TextDecoder().decode(init?.body as BufferSource),
            ),
          );
          return new globalThis.Response(
            events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
              "data: [DONE]\n\n",
            { headers: { "content-type": "text/event-stream" } },
          );
        };
        const layer = OpenRouterLanguageModel.model("synthetic/model", {
          modalities: ["text", "image"],
        }).pipe(
          Layer.provide(
            OpenRouterClient.layer({
              apiKey: Redacted.make("synthetic"),
              apiUrl: "https://mock.invalid/api/v1",
            }),
          ),
          Layer.provide(
            FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
          ),
        );
        const tool = Tool.make("inspect_image", {
          parameters: Tool.EmptyParams,
          success: Schema.String,
        });
        const kit = Toolkit.make(tool);
        const toolkit = yield* kit.pipe(
          Effect.provide(kit.toLayer({ inspect_image: () => Effect.succeed("Inspected") })),
        );
        const parts = yield* Stream.runCollect(
          LanguageModel.streamText({ prompt: "Generate", toolkit }),
        ).pipe(Effect.provide(layer));
        expect(parts.some((part) => part.type === "tool-call")).toBe(true);
        expect(parts.some((part) => part.type === "tool-result")).toBe(true);
        const replay = responseTurnPrompt(parts);
        const assistant = replay.content[0]!;
        expect(assistant.role).toBe("assistant");
        if (assistant.role !== "assistant") throw new Error("Missing assistant replay");
        expect(assistant.content.map((part) => part.type).slice(0, 3)).toEqual([
          "text",
          "file",
          "text",
        ]);
        expect(assistant.options.openrouter?.reasoningDetails).toEqual(details);
        yield* Stream.runCollect(
          LanguageModel.streamText({ prompt: Prompt.concat(replay, Prompt.make("Edit")), toolkit }),
        ).pipe(Effect.provide(layer));
        expect(requests[1]!.messages[0]).toMatchObject({
          role: "assistant",
          content: "BeforeAfter",
          images: [
            { type: "image_url", image_url: { url: image } },
            { type: "image_url", image_url: { url: editedImage } },
          ],
          reasoning_details: details,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "inspect_image", arguments: "{}" },
            },
          ],
        });
        expect(requests[1]!.messages[1]).toMatchObject({
          role: "tool",
          tool_call_id: "call-1",
          // Since rc.117 a string result is sent as is, not JSON-encoded.
          content: "Inspected",
        });
      }),
  );
  it.effect("keeps ordinary duplicate reasoning deduplication without image replay opt-in", () =>
    Effect.gen(function* () {
      const requests: Array<{ messages: Array<Record<string, unknown>> }> = [];
      const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(
          JSON.parse(
            typeof init?.body === "string"
              ? init.body
              : new TextDecoder().decode(init?.body as BufferSource),
          ),
        );
        return new globalThis.Response(
          `data: ${JSON.stringify({ ...chunk({}, true), usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      };
      const layer = OpenRouterLanguageModel.model("synthetic/model").pipe(
        Layer.provide(
          OpenRouterClient.layer({
            apiKey: Redacted.make("synthetic"),
            apiUrl: "https://mock.invalid/api/v1",
          }),
        ),
        Layer.provide(
          FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
        ),
      );
      const assistant = Prompt.makeMessage("assistant", {
        content: [Prompt.makePart("text", { text: "answer" })],
        options: { openrouter: { reasoningDetails: details } },
      });
      yield* Stream.runDrain(
        LanguageModel.streamText({
          prompt: Prompt.make([
            assistant,
            Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text: "again" })] }),
            assistant,
          ]),
        }),
      ).pipe(Effect.provide(layer));
      expect(requests[0]!.messages[0]!.reasoning_details).toEqual(details);
      expect(requests[0]!.messages[2]!.reasoning_details).toBeUndefined();
    }),
  );
});

it.effect("streams refusal deltas as text through the actual patched image adapter", () =>
  Effect.gen(function* () {
    const events = [
      chunk({ content: null, refusal: "I cannot " }),
      chunk({ content: "", refusal: "draw that." }),
      chunk({ content: " Try ", refusal: "another request." }),
      {
        ...chunk({}, true),
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16, cost: 0.04 },
      },
    ];
    const fetch = async () =>
      new globalThis.Response(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    const layer = OpenRouterLanguageModel.model("synthetic/image", {
      modalities: ["text", "image"],
    }).pipe(
      Layer.provide(OpenRouterClient.layer({ apiUrl: "https://mock.invalid/api/v1" })),
      Layer.provide(
        FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
      ),
    );
    const parts = yield* LanguageModel.streamText({ prompt: Prompt.make("Draw") }).pipe(
      Stream.runCollect,
      Effect.provide(layer),
    );
    expect(parts.flatMap((part) => (part.type === "text-delta" ? [part.delta] : [])).join("")).toBe(
      "I cannot draw that. Try another request.",
    );
    expect(parts.filter((part) => part.type === "text-start")).toHaveLength(1);
    expect(parts.filter((part) => part.type === "text-end")).toHaveLength(1);
    expect(parts.find((part) => part.type === "finish")).toMatchObject({
      reason: "stop",
      metadata: { openrouter: { usage: { cost: 0.04 } } },
    });
  }),
);
