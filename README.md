# Chat

A self-hosted, ChatGPT-style chat app built as a modular monolith.

- **Runtime**: Node 24, pnpm
- **Framework**: TanStack Start + Router + Query + Form, React 19, Vite 8
- **Styling**: Tailwind CSS 4, Base UI (`@base-ui/react`) shadcn-style components (`base-luma`), Hugeicons, Geist
- **Effects**: Effect 4 (rc) — services, DI layers, typed errors, streams, retries, resources
- **Database**: PostgreSQL, Drizzle ORM 1.0 (rc) with the Effect client (`drizzle-orm/effect-postgres` on `@effect/sql-pg`), generated migrations
- **Auth**: Better Auth (Drizzle adapter, admin plugin). The **first registered user becomes the instance admin**.
- **AI**: OpenRouter / OpenAI-compatible providers via `@effect/ai-openrouter`; providers and models are managed in the admin panel, with autocomplete backed by each provider's live `/models` catalog
- **Tests**: Vitest 4, `@effect/vitest`, Testing Library + jsdom, Testcontainers
- **Lint/format**: oxlint + oxfmt

## Getting started

```sh
docker compose up -d          # local Postgres
cp .env.example .env          # then fill in real secrets:
                              #   BETTER_AUTH_SECRET: openssl rand -hex 32
                              #   PROVIDER_KEY_SECRET: openssl rand -base64 32
pnpm install
pnpm db:migrate
pnpm dev
```

Register at `http://localhost:3000/register` — the first account is the admin. Open the
user menu (bottom-left) → **Admin** → add a provider (e.g. OpenRouter + API key), pick
models from the autocomplete, then start chatting.

## Architecture

```
src/
  server/            composition root: Effect Layer graph + shared ManagedRuntime
  modules/
    auth/            Better Auth config, session middleware, client
    chat/            conversations, messages, stream engine, chat UI
    providers/       provider/model registry, API-key crypto, AI gateway
    admin/           admin server functions + panel UI
    sync/            user-scoped event bus (PubSub + LISTEN/NOTIFY), SSE plumbing
  shared/
    db/              drizzle schema, relations, plain client (for Better Auth)
    ui/              shadcn-generated primitives + app form kit
  routes/            TanStack file routes (thin; delegate into modules)
```

Modules own their domain end to end (`server/`, `client/`, `ui/`, schemas, errors).
`shared/` holds only cross-module infrastructure: the DB schema (shared by design —
relations span modules) and the generated UI kit (the paths shadcn's CLI is configured
to target in `components.json`).

### Resumable streams

Assistant generation runs **detached from the HTTP request** in the Effect runtime
(`StreamEngine`): deltas are numbered by `seq`, batched into `message_chunks`, and
published to an in-process PubSub. Clients subscribe via SSE
(`GET /api/messages/:id/stream?after=<seq>`): the server subscribes to live events
first, replays persisted chunks after `seq` from Postgres, then switches to the live
tail (deduped by seq) and ends with a terminal `done` event. Reloading, opening a
second tab, or another browser mid-generation all resume seamlessly; the conversation
loader ships already-persisted chunks inline so first paint is complete.

### Cross-session sync

Domain events (conversation created/renamed/deleted, message created, status changes)
go through `SyncBus`: published to Postgres `NOTIFY`, relayed into each instance's
PubSub, and fanned out per user over `GET /api/sync` SSE. The client applies them as
TanStack Query invalidations, so the sidebar and open chats stay in sync across tabs,
browsers, and instances.

## Commands

```sh
pnpm dev            # dev server on :3000
pnpm build          # production build (nitro) -> .output/
pnpm start          # run production server
pnpm test           # all vitest projects (unit, integration*, ui)
pnpm typecheck
pnpm lint / format
pnpm db:generate    # drizzle-kit generate from schema changes
pnpm db:migrate
```

\* integration tests start a disposable Postgres via Testcontainers (Docker required).
