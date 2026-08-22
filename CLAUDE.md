# CLAUDE.md

Chat app — modular monolith. TanStack Start + Effect 4 (rc) + Drizzle 1 (rc) + Better Auth.
See README.md for architecture; this file records the sharp edges.

## Version pins (all release candidates — pin exactly, don't float to `latest`)

- `effect@4.0.0-rc.x` and every `@effect/*` package must share the SAME rc version
  (`@effect/vitest`, `@effect/sql-pg`, `@effect/ai-openrouter` are on the `rc` dist-tag).
  `latest` on those packages is still Effect 3 — never mix.
- `drizzle-orm` / `drizzle-kit` are on `1.0.0-rc.5-*` builds. rc.4 crashes at import time
  with effect >= 4.0.0-beta.104 (`Schema.TaggedErrorClass` was renamed to `Schema.TaggedError`).
- `vitest` must be v4 (peer of `@effect/vitest` rc).

## Effect 4 API notes (differs from most Effect 3 docs online)

- Services: `class X extends Context.Service<X, Shape>()("id")`, layers built explicitly
  with `Layer.effect` — there is no `.Default` or `dependencies` option.
- `Schema.toStandardSchemaV1(schema)` converts to Standard Schema for TanStack
  `.validator()` / Form `validators`.
- `Effect.forkDetach` (was forkDaemon), `Fiber.join`, `PubSub.subscribe` needs a Scope,
  `Stream.fromEffectSchedule`, `Stream.toReadableStreamWith(stream, context)`.
- `Effect.catch` (not `catchAll`); `Effect.timeout` takes a `Duration`, not a string.
- Drizzle Effect client: `makeWithDefaults({ relations })` from `drizzle-orm/effect-postgres`;
  requires `PgClient` provided at the composition root (`src/server/runtime.ts`) so the
  SyncBus LISTEN/NOTIFY shares the same pool.

## Tool calling (`effect/unstable/ai`)

- `LanguageModel.streamText` is ONE model turn. The multi-turn tool loop is ours
  (`src/modules/chat/server/streaming.ts`): re-run while `finish.reason === "tool-calls"`,
  feeding the previous turn back with `Prompt.concat(prompt, Prompt.fromResponseParts(parts))`.
- `OpenRouterLanguageModel` only emits the `finish` part when a chunk carries `usage`.
  A provider (or mock) that omits usage hangs the loop forever — real OpenRouter always
  sends it because the client forces `stream_options: { include_usage: true }`.
- A handler's second arg is `Toolkit.HandlerContext`: `ctx.preliminary(result)` streams
  progress as `tool-result` parts with `preliminary: true`. Those are UI-only — the
  stream loop must keep them out of the continuation transcript.
- Tool page bodies are never persisted. `message_tool_calls.result` holds the summary
  plus the source list (url/title/status) only.

## Citations / streamdown

- Citations ride on GFM footnotes (`[^N]`), not markdown links: a half-streamed
  `[text](htt` renders as an unoverridable `[blocked]` span (streamdown rejects an
  undefined href _before_ consulting `components.a`), while `[^1` is just literal text.
- The model writes markers only. We synthesize the `[^N]: url` definitions from the tool's
  own source list (`prepareCitedMarkdown`, `src/modules/chat/ui/citations.ts`) — without
  them GFM leaves `[^1]` as raw text until the definitions arrive, i.e. never mid-stream.
- Two streamdown 2.5.0 output details are load-bearing: the `#user-content-fn-N` href on a
  footnote ref, and the `data-footnotes` attribute on the appended section. hast gives that
  attribute the _empty string_, so suppress on `!== undefined` — a truthiness check silently
  renders the list. Both are pinned by `message-list.test.tsx`; re-probe on upgrade.
- Citation numbers are per assistant message: `WebSearchExecutor.prepare()` runs once per
  generation and closes over the counter, so a second search continues the sequence.

## Invariants

- One live `ManagedRuntime` per process (`src/server/runtime.ts`). Server functions/routes
  run effects with `runtime.runPromise`. Dev HMR re-runs the module on any layer-graph
  change; each evaluation disposes the previous runtime (globalThis stash) and takes over —
  repo/service edits apply without restarting `pnpm dev`. Vite never calls
  `import.meta.hot.dispose` for server modules, which is why the module does it itself.
- `message_chunks.seq` starts at 1 and is contiguous per message; resume protocol relies
  on it (`?after=<seq>` replays from Postgres, then live tail dedupes by seq).
- Better Auth owns its tables' columns — `src/db/schema/auth.ts` must mirror what
  the installed better-auth version expects (1.7 added `account.issuer`). After a
  better-auth upgrade, verify against a fresh signup before shipping.
- Provider API keys are AES-256-GCM encrypted at rest (`PROVIDER_KEY_SECRET`, base64
  32 bytes); ciphertext never leaves the server (`toPublic` strips it).
- First registered user becomes admin via the `user.create.before` database hook — do not
  bypass Better Auth for user creation.
- Nitro's Vite **dev** middleware guesses static assets from `sec-fetch-dest`: anything
  that is neither `empty` nor a document dest never reaches the app, so
  `<img src="/api/files/:id">` 404s while `fetch()` on the same URL works. `vite.config.ts`
  strips that header for `/api/*` (dev only — the built server routes them directly).

## Workflow

- Schema change → `pnpm db:generate` → commit the `drizzle/` folder → `pnpm db:migrate`.
- `pnpm typecheck && pnpm lint && pnpm test` before considering work done.
  Integration tests need Docker (Testcontainers).
- UI primitives in `src/ui/primitives` are shadcn-generated (Base UI, style
  `base-luma`) — regenerate via `pnpm dlx shadcn@latest add <component>`, don't hand-roll.
