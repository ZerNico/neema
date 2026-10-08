# Contributing

Read [AGENTS.md](AGENTS.md) before changing anything. It has the glossary, the ways to
hurt yourself and how to verify a change, for people and coding agents alike.

## Setup

You need Node 24.2 or newer, pnpm (the version is pinned in `package.json`) and Docker.

```sh
pnpm install
pnpm dev:setup   # starts Postgres and SearXNG in Docker and prepares this checkout
pnpm dev         # the web app and the desktop app, rebuilt on every change
```

Open the printed URL and create the admin account. Add a model
provider under **Admin → Providers**, and SearXNG at `http://localhost:8081` as a search
provider under **Admin → Tools**.

The dev server runs behind [Portless](https://github.com/vercel-labs/portless), which
creates a local HTTPS certificate and may ask for your password the first time. Every
checkout, worktrees included, gets its own database, files and desktop profile. See
[development isolation](docs/internals/development.md) for how that works.

## Commands

```sh
pnpm dev:web        # the web app alone
pnpm dev:desktop    # the desktop app alone
pnpm dev:info       # where this checkout's database and files are
pnpm dev:import     # copy the main checkout's data into a worktree
pnpm dev:destroy    # remove this checkout's database and files, before deleting a worktree

pnpm test           # unit, UI and integration tests (integration needs Docker)
pnpm typecheck
pnpm lint
pnpm format

pnpm db:generate    # write a migration after changing the schema
pnpm db:migrate     # apply it to this checkout's database

pnpm build          # production build into apps/web/.output
pnpm --filter @chat/desktop package   # desktop installers for this OS
```

## Before you open a pull request

Run `pnpm typecheck && pnpm lint && pnpm test`. Lint must report no errors. CI runs the
same checks, and `ci-ok` is the one that must pass.

Commit titles are short and imperative ("Add a Jira integration"). The body says what
was wrong and how the change fixes it. One concern per commit.

## Where things live

```
apps/web/       the server and the web app (TanStack Start, React, Effect, Drizzle)
  src/modules/  one folder per feature: chat, knowledge, projects, integrations, …
  src/routes/   thin route files that hand off to modules
  src/ui/       the design system
  drizzle/      database migrations
apps/desktop/   the Electron shell
packages/       the model client and the desktop protocol
docs/internals/ design decisions and traps, one file per area
```

[Deployment and releases](docs/internals/deployment.md) covers the image and how a
release is made.
