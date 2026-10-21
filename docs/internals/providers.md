# Providers

A provider is a service the app sends model requests to. It is stored as a **preset** (which
service it is) plus the few **settings** an admin changed from that preset. Every request goes
through `@chat/model-client` (`packages/model-client`), our own adapter for anything
OpenAI-like, so chat, side generations, deep research and scanned-PDF reading follow the
provider without knowing it.

## Why our own client

Effect's OpenRouter and OpenAI adapters each needed patches for behaviour we depend on (image
replay, refusals, ordered reasoning state, cache markers on tool results, loose tool schemas)
and still covered only two services. Every OpenAI-compatible service differs in small ways,
so the client keeps those differences as data in one table (`preset.ts`) read by its codecs:
Chat Completions, Responses, and Anthropic's Messages for the models a preset routes there. It
implements Effect's `LanguageModel`, so the toolkit loop,
Hermes polyfill and tests are unchanged. Adding a service is a preset, not a branch.

## Presets and settings

- A preset fixes the endpoint, auth (bearer, `api-key`, or none for self-hosted), wire
  formats, the reasoning request field, what reasoning goes back in history, cache key,
  output-limit field, catalog kind, a chat model's own image output and the image model
  families it hosts. Image models are rows of their own type, called through the image
  adapters rather than a wire format, and never gated by the chat image-output flag. See
  [images](images.md).
- Presets exist where a service needs behaviour no setting expresses (OpenRouter, OpenAI,
  Azure, Bedrock, Vercel) or is common enough that its settings should not be looked up (Gemini,
  DeepSeek, Mistral, Groq, xAI, Ollama). Everything else is the OpenAI-compatible preset with
  the right settings, which can express all the rest.
- `overridable` lists what an admin may change, and the admin UI shows nothing else: a fixed
  value shown as a setting reads as a choice. Most presets allow nothing; the generic
  OpenAI-compatible preset allows everything, the key header included, since there the server
  decides. OpenAI and xAI are fixed to Responses, every current model taking it and GPT-5.4+
  needing it for tools with reasoning.
  The server keeps only allowed keys that differ from the preset (`sanitizeSettings`), so a
  stored row says exactly what was changed, and a preset fix reaches every row left on it.
- Unknown request fields are never sent: strict servers (OpenAI, Groq, Mistral, LiteLLM)
  reject them. That is why reasoning and cache keys are per preset rather than sent always.

## What the client guarantees

- **One finish per call.** A round finishes at `[DONE]` or a Responses terminal event, at once,
  however long the server keeps the connection open after it. The first finish reason stands,
  so a usage chunk repeating `stop` cannot hide a cut-off. A Chat Completions stream that ends
  after a finish reason without `[DONE]` still counts, its usage unknown; one that ends with
  neither is a network error, never a silent success. Missing usage is unknown, not zero.
- **No truncated calls run.** Tool calls are emitted only at the end of a round, and not at all
  when it stopped on length, a content filter or an error. Arguments are assembled by index,
  then id (Ollama numbers parallel calls alike, while an id arriving after a call began is the
  same call's), with relays' repeated argument strings ignored. Hermes follows the same boundary:
  parsed text calls stay inert until an explicit successful terminal finish. Length, filter,
  error, unknown finishes, provider failure and EOF discard them without running handlers.
- **SSE limits are per event.** The 64 MiB cap counts wire bytes, including ignored fields and
  line endings, before dispatch and reset. UTF-8 splits and EOF decoding do not bypass it,
  and a transport chunk containing several bounded events is not capped as one event.
- **Calls run against the whole toolkit.** A `oneOf` choice narrows what is advertised; a call
  to any toolkit tool still runs, which deferred tools rely on.
- **An empty optional is absent.** Some models fill every key they are offered and write the
  ones they mean to leave out as `""`. A key the advertised schema cannot take empty (a minimum
  length, an enum, a format, a non-string type) is dropped before the toolkit decodes the call,
  in the client for native calls and in the Hermes parser for text ones. Without that, a strict
  schema fails the whole generation, and a handler that decodes leniently answers with a
  correction the model repeats. A required key, or one where `""` is a value, stays as written.
  Tools advertised through `advertisedAs` with a looser schema than they decode still own their
  own rule (the document tools do).
- **Refusals are text**, tagged `modelClient.refusal` in part metadata.
- **Inline reasoning is split only where it opens the answer.** Models that write their
  reasoning as a leading `<think>` block get it on the reasoning track, on every service; a
  tag later in the answer stays text, so an answer explaining that format is not swallowed.
  A server that puts the opening tag in its prompt template streams only `</think>`, which is
  not recognised: turn on its reasoning parser instead.
- **Usage is normalised** to Effect's shape with the input total including cache reads and
  writes, whichever dialect a service uses (OpenAI details, DeepSeek hit counts,
  Anthropic-style counts beside the prompt count). A provider-reported cost travels as
  `modelClient.cost`.

## Reasoning state across rounds and turns

Some services need their own opaque state back to continue: OpenRouter's signed
`reasoning_details`, DeepSeek's and Kimi's `reasoning_content` with tool calls, Gemini's thought
signatures on tool calls, Responses' encrypted reasoning items and message `phase`. Each model
round's state is one **replay unit** (`replay.ts`), stamped with the connection that produced
it: provider id, base URL, wire format and model. The client sends a unit back only to that
same connection, once per request, and never synthesises missing state.

- Reasoning goes back as received unless **Send reasoning back** is off: `reasoning_details`
  or `reasoning_content`, in the field the server used, so DeepSeek, Kimi and GLM keep their
  reasoning across tool rounds without settings. Never the plain `reasoning` field, which Groq
  rejects. The switch is read when a request is built, so turning it off takes effect at once.
- Within an answer, `roundPrompt` turns a round's parts into the continuation prompt with the
  unit on the assistant message, keeping files where they streamed.
- Across turns, `messages.provider_replay` keeps each round's unit with the span of answer text
  it covers. History rebuilds those rounds with their tool calls and results only for the same
  provider and model; anything else gets the plain transcript. A unit is never sent to a
  client, and branch, retry, resume and compaction treat it as part of its answer.
- A unit never holds tool-call arguments: the app redacts some (document bodies, drafts,
  memory) before they go back, and a second copy here would undo that and outlive deletions.
  A Responses unit keeps each call's place and id, and the arguments come from the prompt.
- A Responses unit is replayed exactly only while the visible text still matches what the model
  wrote; after an edit only the reasoning items go back and the rest is rebuilt.
- Only rounds that returned state are recorded (every round, for an image answer), so history
  treats the stretches between recorded rounds as rounds of their own, with their calls.

## Wire formats

- **Chat Completions** is the shared standard. Files in an assistant turn move to a user
  message after its tool results, except OpenRouter images, which it takes inline. A model
  named Claude gets Anthropic's fine-grained tool streaming header: without it Anthropic holds
  each argument value back until it is complete, so a document written through a tool arrived
  in one burst (measured through 9router, which passes the header on). Other backends ignore it.
  Over the Messages API (Claude on Bedrock) the same comes from `eager_input_streaming` on each
  tool, which replaced the header there. Arguments then arrive unvalidated, so broken JSON fails
  the call when its block closes, as it always did.
- **Responses** is OpenAI's newer API: always `store: false` with encrypted reasoning
  included, a summary asked for (and dropped once if OpenAI refuses it to an unverified
  organisation), and tool schemas sent with `strict: false`, since omitting it means strict
  there and strict makes optional keys required. GPT-5.4 and later refuse tools with reasoning
  on Chat Completions, so such a request fails before it is sent with a reason that names the fix.

## Azure

One preset covers both Azure OpenAI (`*.openai.azure.com`) and Foundry (`*.services.ai.azure.com`)
resources, which also host other vendors' models. Base URL is the resource endpoint, not a
project's; the preset completes it to `/openai/v1` and authenticates with `api-key`. A model
key is a deployment name. The v1 `/models` lists the region's base models, not deployments, so
the catalog reads the older data-plane deployment listing, which also names each deployment's
model.

Responses serves OpenAI's models and most models Azure sells itself (DeepSeek, Grok, Llama,
MAI), but not every deployment, and Azure publishes no complete list. So the API is each
model's, stored on its row (`models.format`, null meaning Responses), never the provider's
(`modelFormat` on the preset). A deployment answering "model not supported" gets the same
request on Chat Completions, and the gateway records that on the row: the next call starts
there, the admin sees it in the model dialog, and switching it back is an ordinary edit. The
model dialog's Test runs the same fallback and puts what answered into the form.

## Amazon Bedrock

One Bedrock provider serves two APIs. Claude refuses the OpenAI-compatible API and speaks only
Anthropic's Messages, so the preset routes model IDs containing `anthropic.` (plain or an
inference profile such as `eu.anthropic.…` or `global.anthropic.…`) to the Messages codec, and
every other model to Chat Completions. The routing is per
model, not a setting, so one provider serves both kinds.

Claude always goes to `bedrock-runtime` in the provider's region, at `/anthropic/v1/messages`,
even when the base URL is mantle. Only runtime takes geo and global inference profiles; mantle
serves Claude in-region in a few regions only, so an EU deployment could not reach current
Claude models there at all.

Mantle's `/models` lists no Claude, so the catalog adds the account's Claude inference profiles
from the control plane (`bedrock.<region>.amazonaws.com`, `ListInferenceProfiles`), which
carry the exact IDs runtime takes, versioned where a model has one. Listing them is an IAM
permission of its own (`bedrock:ListInferenceProfiles`); without it the catalog still shows
mantle's models and Claude is simply missing, so a signing user needs it to pick Claude from
the list. The listing names every profile the account could enable, so it includes models
without access and old ones without Messages; Test in the model dialog tells them apart.

AWS's compatibility table is not the last word on which Claude models take Messages: Sonnet 4.6
does though listed without it, while Sonnet 4.5 answers "doesn't support this API" and stays
unreachable, taking only Converse and Invoke. The catalog lists such profiles all the same.

- **Signing in.** A Bedrock API key goes out as a bearer token (`x-api-key` on Messages), or
  an IAM access key signs each request with SigV4. The signer covers the exact body bytes, so
  every request is serialised once before it is signed. The signing name follows the host:
  `bedrock-mantle` for mantle, which IAM treats as its own service, `bedrock` for runtime. A
  signing user with both kinds of model therefore needs `bedrock-mantle:CreateInference` and
  `bedrock:InvokeModelWithResponseStream`.
  Access keys are stored as one JSON document in the encrypted key column, read only when the
  provider's `auth` setting says so. No ambient credentials and no session tokens: temporary
  keys would expire in the database.
- **Endpoint.** A bare region becomes the `bedrock-mantle` endpoint, the only one with
  `/models`. A typed `bedrock-runtime` URL works for requests but lists nothing, and its model
  IDs differ (`openai.gpt-oss-120b` on mantle, versioned or inference profile IDs on runtime).
- **Messages requests.** Anchors always become `cache_control`, at most four. A reasoning
  level sends adaptive thinking with the level as `effort`, summarised, since newer models omit
  their thinking text otherwise. Haiku 4.5 refuses adaptive thinking, so it gets no reasoning
  levels in its model settings; without levels no thinking is sent. Signed thinking goes back before its tool calls only beside
  unchanged text; a forced tool with reasoning is refused, as Claude cannot do both.
- **Chat Completions there, fixed.** Tried against every model an account listed: only gpt-oss
  takes Responses, so offering the switch would break the rest. Every model accepted
  `reasoning_effort`, those without levels ignoring it, and it goes out only for a level a user
  picked, so the field is fixed too and the provider's only setting is how it signs in. OpenAI's GPT-5.4 and later on Bedrock therefore cannot take tools with a
  reasoning level: such a request is refused before it is sent, and turning reasoning off for
  the model is the fix. Routing them to Responses like Claude to Messages is the way to lift
  that, held back until it can be checked against an account that has them.

## Checking a service

`packages/model-client/scripts/live-check.ts` runs a short reply, a tool round with its
continuation and a repeated long prompt against real services, keys taken from environment
variables. It costs real requests and is never part of the test suites.

## Setting up a service

Until there is a docs site, the admin setup lives here. A service in the preset list needs only
a key (and, for Azure and Ollama, the server's address, for Bedrock its region). Every other service uses
**OpenAI-compatible**, set as its row says. Each row lists every setting, so nothing is left to
a default.

These rows come from each service's documentation, and not all were tried with a live key. If
one misbehaves, see the list after the table.

| Service                  | Base URL                                                          | API              | Reasoning level field                              | Send reasoning back | Ask for token usage | Key header |
| ------------------------ | ----------------------------------------------------------------- | ---------------- | -------------------------------------------------- | ------------------- | ------------------- | ---------- |
| Kimi (Moonshot)          | `https://api.moonshot.ai/v1`                                      | Chat Completions | Not sent                                           | On                  | On                  | Empty      |
| GLM (Z.ai)               | `https://api.z.ai/api/paas/v4`                                    | Chat Completions | Not sent                                           | On                  | On                  | Empty      |
| Qwen (Alibaba DashScope) | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`          | Chat Completions | Not sent                                           | On                  | On                  | Empty      |
| Together AI              | `https://api.together.xyz/v1`                                     | Chat Completions | `reasoning_effort`                                 | On                  | On                  | Empty      |
| Fireworks                | `https://api.fireworks.ai/inference/v1`                           | Chat Completions | `reasoning_effort`                                 | On                  | On                  | Empty      |
| Cerebras                 | `https://api.cerebras.ai/v1`                                      | Chat Completions | `reasoning_effort`                                 | On                  | On                  | Empty      |
| LiteLLM                  | Your proxy, e.g. `http://localhost:4000/v1`                       | Chat Completions | `reasoning_effort`                                 | On                  | On                  | Empty      |
| 9router                  | Your instance's `/v1` URL                                         | Chat Completions | `reasoning_effort`                                 | On                  | On                  | Empty      |
| New API                  | Your instance's `/v1` URL                                         | Chat Completions | `reasoning_effort`                                 | On                  | On                  | Empty      |
| Cloudflare AI Gateway    | `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/compat` | Chat Completions | Not sent                                           | On                  | On                  | Empty      |
| vLLM                     | Your server, e.g. `http://localhost:8000/v1`                      | Chat Completions | `reasoning_effort` for gpt-oss, otherwise Not sent | On                  | On                  | Empty      |
| SGLang                   | Your server, e.g. `http://localhost:30000/v1`                     | Chat Completions | Not sent                                           | On                  | On                  | Empty      |
| LM Studio                | `http://localhost:1234/v1`                                        | Chat Completions | Not sent                                           | On                  | On                  | Empty      |
| llama.cpp                | `http://localhost:8080/v1`                                        | Chat Completions | Not sent                                           | On                  | On                  | Empty      |

Notes per service:

- Kimi, GLM and Qwen choose reasoning by model (or think by default), so no level field is sent
  and the chat offers no level picker. Their reasoning still goes back on tool rounds, which
  Kimi and GLM need.
- LiteLLM: set `drop_params: true` in its config, so it drops fields a routed model does not
  take.
- Cloudflare AI Gateway lists no models: type the model IDs.
- vLLM and SGLang: start the server with a reasoning parser, so reasoning arrives in its own
  field rather than inside the answer. vLLM can also serve the Responses API.
- Leave the key empty for a local server that takes none. A gateway that wants its key in
  another header (`api-key`, `x-api-key`, an API management subscription header) gets that
  name in **Key header**.

### When something is off

- **Reasoning never shows:** the server may write it into the answer as a `<think>` block
  without the opening tag. Turn on its reasoning parser, which sends reasoning separately.
- **"Unknown field" or "extra inputs" errors:** set **Reasoning level field** to Not sent, or
  turn off **Ask for token usage**. Strict servers reject fields they do not know.
- **A server rejects the second request of a tool round:** turn off **Send reasoning back**.
- **Tool calls fail after the first round with a reasoning model:** turn **Send reasoning
  back** on.
- **No costs in analytics:** only some providers report what a request cost. For the rest,
  enter the model's prices in its settings, cache prices included.
