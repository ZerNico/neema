# Deployment and releases

## The image

The root `Dockerfile` builds one image that serves the web app on port 3000. On start
it applies pending migrations (`.output/migrate.mjs`, under an advisory lock, so
replicas starting together take turns) and then serves. `MIGRATE_ON_START=false`
leaves migrations to the operator. Uploads, custom tool builds and OCR models live
under `/data`.

The browser and Electron load the same SPA. `pnpm start` enables Start's shell mode
before loading the Nitro server. A deployment that invokes
`apps/web/.output/server/index.mjs` directly must set `TSS_SHELL=true` itself. The backend still
serves authentication, server functions, API routes and SSE. `pnpm build` checks the emitted shell and production deep links
with database access disabled, serving a copy of `.output` from outside the repository,
so a module missing from the build cannot quietly resolve from `node_modules`.

The image build passes the version and commit into the web build, and the admin nav
shows them. They are declared after dependencies install, so a new version never
invalidates the dependency layers.

## Releases

Push a tag such as `v1.2.3`, or `v1.2.3-rc.1` for a prerelease. `release.yml` then:

1. creates a draft release with GitHub's generated notes,
2. runs CI,
3. publishes the multi-arch image as `1.2.3` only, and packages the desktop app for
   macOS, Windows and Linux,
4. attaches the installers and `SHA256SUMS.txt` to the draft.

Someone then rewrites the notes, from the commits since the last tag, and publishes
the draft by hand. Nothing is announced before a person has read it. Publishing runs `promote.yml`,
which points `1.2`, `1` and `latest` at the `1.2.3` image without rebuilding it, so
people following `latest` never get a version before its notes. Prereleases move none
of them, and `1` stays unset while the major version is 0. Assets are
attached before publishing because an immutable release can't gain assets afterwards.
A failed run leaves the draft, and a re-run reuses it.

Pushes to `main` publish the image as `edge`. The desktop installers are unsigned:
signing needs paid certificates, not code.
