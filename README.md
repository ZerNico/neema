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
- **Lint/format**: oxlint (`oxlint.config.ts`) + oxfmt, with `eslint-plugin-slop` loaded as an oxlint JS plugin for recently changed lines

## Getting started

```sh
pnpm install
pnpm dev:setup               # Docker required; isolated Postgres on 127.0.0.1:5433
pnpm dev                    # Portless web URL and an isolated desktop profile
```

Portless creates a local HTTPS certificate and may prompt for sudo on first use.
Run `pnpm exec portless proxy start` in a terminal first if launching through an
agent. For an unprivileged proxy, use
`pnpm exec portless proxy start --port 1355 --https`; URLs then include `:1355`.

Open the printed URL and register: the first account is the admin. Open the
user menu (bottom-left) → **Admin** → add a provider and pick models.
Development starts empty by default. The primary checkout’s selected generated dev
instance is the seed source for every worktree. Run `pnpm dev:import` in a
worktree and confirm; the primary app can keep running, only the worktree’s own
server must be stopped. In a T3 Code worktree, choose
**Seed development data** from its scripts menu to run the same staged copy without
a prompt. It copies the primary database and blobs and reuses its provider encryption
key. The source stays unchanged; a failed import keeps the current dev state, and a
successful one replaces it and removes the copy it superseded. Imported provider keys
are real, so new generations can incur charges. Sign in with an existing
email/password; OAuth is disabled in the copy, and OAuth-only snapshots are refused.

### Worktrees

Run `pnpm install --frozen-lockfile && pnpm dev:setup` in each new checkout.
T3 Code does this through `t3.json`. Plain Git worktrees work the same way.
Portless names the main checkout `chat.localhost` and prefixes linked worktrees
with their branch name. Each checkout has a separate database, blob directory,
secrets and Electron profile in the shared development stack defined by root
`docker-compose.yml`. That stack is local development only, named `chat-development`,
and binds Postgres only on port 5433.

`pnpm dev:setup` is safe to repeat and applies pending migrations. `pnpm dev:info`
prints the database, storage paths and last launched URL, without credentials.
Retire a checkout with `pnpm dev:destroy` **before removing its worktree**: it drops
only this checkout’s databases and role, then removes its state. If that order was
missed, `pnpm dev:destroy --orphans` reports tagged databases whose recorded checkout
path is gone and asks before dropping them. Untagged legacy databases are reported,
never deleted. The shared container and every other checkout are untouched.
Generated state stays in `.data/dev/`; do not copy it between checkouts or delete
its secrets while retaining its database. The harness never reads `apps/web/.env`.
Root `db:migrate`, `db:push` and `db:studio` target this isolated development database.
For intentional deployment migrations, invoke the web package’s `db:migrate`
with an explicitly supplied `DATABASE_URL` instead.

`pnpm dev:setup` starts shared Postgres and SearXNG. Configure
`http://localhost:8081` under Admin → Tools in each development instance.
OAuth providers may reject `.localhost` callbacks; use local email/password login,
or configure Portless with a domain accepted by your provider.
See [development isolation](docs/internals/development.md) for lifecycle and safety constraints.

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
  db/                drizzle schema, relations, plain client (Better Auth only)
  ui/                shadcn-generated primitives + app form kit
  routes/            TanStack file routes (thin; delegate into modules)
```

Modules own their domain end to end (`server/`, `client/`, `ui/`, schemas, errors).
The only cross-module code sits at the top level: `db/` (the schema is shared by
design — relations span modules) and `ui/` (the design system; shadcn's CLI is
configured to generate into it via `components.json`).

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

## Working on it

`AGENTS.md` is the entry point for anyone (or any agent) changing the code: glossary,
the ways to hurt yourself, what to check before finishing, and how to verify.
`docs/internals/` holds the decisions and traps per area; `AGENTS.md` links them.

## Commands

```sh
pnpm dev:setup        # start shared Postgres/SearXNG and provision this checkout
pnpm dev:setup:seeded # provision, then import normal development data without a prompt
pnpm dev:info         # show isolated paths and the last launched URL
pnpm dev:import       # copy the primary checkout’s selected state into this worktree
pnpm dev:destroy      # drop this checkout’s databases, role and isolated state
pnpm dev:destroy --orphans # report and optionally clean up removed tagged worktrees
pnpm dev            # Portless web app and desktop shell, rebuilt and relaunched on change
pnpm dev:web        # the web app alone
pnpm dev:desktop    # the shell alone, using this checkout’s last web origin
pnpm build          # production build (nitro) -> .output/, with .output/migrate.mjs
pnpm start          # run production server
pnpm --filter @chat/desktop package  # unsigned installers for this OS -> apps/desktop/release/
pnpm test           # all vitest projects (unit, integration*, ui)
pnpm typecheck
pnpm lint / format
pnpm db:generate    # drizzle-kit generate from schema changes
pnpm db:migrate
```

The browser and Electron use the same SPA frontend. `pnpm start` enables Start’s
shell mode before loading the Nitro server. Deployments invoking
`apps/web/.output/server/index.mjs` directly must set `TSS_SHELL=true`; the backend
still serves authentication, server functions, API routes and SSE. `pnpm build`
checks the emitted shell and production deep links with database access disabled,
serving a copy of `.output` from outside the repository so a module missing from
the build cannot resolve from `node_modules`.

\* integration tests start a disposable Postgres via Testcontainers (Docker required).

## Deploying and releasing

The root `Dockerfile` builds the production image. On start it applies pending
migrations (`.output/migrate.mjs`, under an advisory lock) and then serves on port
3000; set `MIGRATE_ON_START=false` to run that step yourself. Uploads and custom tool
builds live in `/data`. `infra/production/compose.yaml` is a single-host example
with Postgres and SearXNG.

GitHub Actions runs format, lint, typecheck and tests on every pull request (`ci-ok`
is the one check to require), builds the image, and publishes it to GHCR as `edge`
from `main`. To release, push a tag:

```sh
git tag v1.2.3 && git push origin v1.2.3   # v1.2.3-rc.1 makes a prerelease
```

That creates a draft release with generated notes, reruns CI, publishes the
multi-arch image (`1.2.3`, `1.2`, `1`, `latest`), packages the desktop shell for
macOS, Windows and Linux, and publishes the release only once every asset is attached.
The installers are unsigned: macOS asks for approval under System Settings → Privacy
& Security on first launch, and Windows SmartScreen warns once.
