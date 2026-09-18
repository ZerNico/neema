# Development isolation

A checkout is an instance, including the primary checkout. The runner hashes its
canonical root path, not its branch name: changing branches must not silently
select another database. Moving a checkout changes that identity; copied state is
refused rather than reusing credentials against the wrong database.

Portless owns route names and port allocation. The Node runner launches Vite and
the desktop dev wrapper as direct children, passing the Portless origin to Better
Auth and Electron. Vite reads PORT explicitly because Portless cannot inject Vite
flags through that wrapper. Only the exact proxy hostname is added to Vite’s
allowed hosts. No TLS verification bypass is installed; trust the Portless CA
before using browser or desktop HTTPS.

The dedicated Compose project `chat-development` owns Postgres on loopback port 5433. It never reuses the personal Compose project, its volume or its credentials.
Setup SQL goes through `docker compose exec` into that container, not an inherited
DATABASE_URL. Each checkout gets a non-superuser owner role and a private database;
the bootstrap administrator installs pgvector before application migrations run.
The server and migrations receive the same generated connection string. Database
identity and passwords are validated before they can become provisioning SQL.

The harness reads no env file. Generated credentials under `.data/dev/instance.json`
are mode 0600 and persist across setup runs. The runner sets database, auth secrets,
blob root and desktop profile in the child environment, overriding inherited values
before Vite loads any env files. Direct package scripts are deliberately
lower-level: they require an explicitly supplied `DATABASE_URL` and provide no such
boundary, which is why `drizzle.config.ts` throws rather than defaulting. Integration
tests still own their separate Testcontainers databases. This is local namespacing,
not a security boundary: every local checkout knows the dedicated container’s
administrator password.

Database rows and blob bytes belong together. Instances start empty, but the explicit
`dev:import` command copies the primary checkout’s selected instance into a worktree.
The primary is found through Git’s common directory, so it is the source no matter
which worktree asks, and it refuses to seed itself. Both databases live in the one
dev server, so dump and restore run container-local. The source is read-only; its
encryption key is reused so provider ciphertext needs no rewrite. These remain real
provider credentials, and a worktree whose branch lags the primary is refused rather
than given a schema its code cannot run.

Import restores into a fresh database and copies blobs into a fresh directory.
Migration history must match the checkout, and every referenced blob must match its
recorded size and digest. Sessions and OAuth tokens are cleared, OAuth providers are
disabled, and active generation, research and indexing work is terminalized before
activation. A non-empty snapshot without a password account is refused, since
disabling OAuth would remove its sign-in path. One atomic manifest rename selects
the new database, blobs, profile and key together. Failure before activation leaves
the current selection intact. A successful import removes the state it supersedes;
failed cleanup is reported as a stale snapshot for `dev:destroy` to remove. Electron
sets its checkout-local userData path before services capture paths or sessions open.
The installed desktop profile stays untouched.

Setup is explicit and idempotent. T3 Code’s worktree hook invokes that same command;
runtime correctness does not depend on which tool created the checkout. T3 exposes a
separate **Seed development data** script that runs `dev:setup --seed`: it imports
normal development state without a prompt, including real provider keys. The hook
does not seed automatically, because disposable worktrees should not silently gain
personal data or incur provider cost. Normal
startup does not migrate. The terminal that started development owns it: Ctrl-C
stops its child processes. `db:migrate`, `db:push`, imports and destruction refuse
to act while the selected database has connections. Studio is read-only from the
launcher’s perspective and may run alongside the server. `dev:info` reports the last
launched URL and resource paths; it never claims a process is live.

There is intentionally no automatic destructive cleanup hook: removing a Git
worktree does not drop its database. Run `pnpm dev:destroy` before removing the
worktree, while its canonical path can still identify its state. Setup writes that
canonical path into a Postgres database comment. If cleanup was missed,
`pnpm dev:destroy --orphans` reports tagged databases whose recorded paths are gone
and requires another confirmation before removing their databases and role. Untagged
legacy databases are reported but never deleted. Neither command removes the shared
Compose volume. Never use `docker compose down --volumes` for per-worktree cleanup:
the dev volume contains every checkout’s database.

There are no separate harness tests. Before relying on a changed runner, create a
linked worktree, run `pnpm dev:setup` and `pnpm dev:web` in both checkouts, inspect
`pnpm dev:info`, then verify import and destroy against only a disposable checkout.
