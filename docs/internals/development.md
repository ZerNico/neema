# Development isolation

A checkout is an instance, including the primary checkout. The runner hashes its
canonical root path, not its branch name: changing branches must not silently
select another database. Moving a checkout changes that identity; copied state is
refused rather than reusing credentials against the wrong database.

Portless owns route names and port allocation. The Node runner launches Vite and
the desktop dev wrapper as direct children, and passes PORTLESS_URL to Better Auth
and Electron. Direct ownership matters at shutdown: pnpm can exit before its
package-script descendants finish cleanup. Vite reads PORT explicitly because
Portless cannot inject Vite flags through that wrapper.
Only the exact proxy hostname is added to Vite’s allowed hosts. No TLS verification
bypass is installed; trust the Portless CA before using browser or desktop HTTPS.

The dedicated Compose project `chat-development` owns Postgres on loopback port
5433. It never reuses the personal Compose project, its volume or its credentials.
Setup SQL goes through `docker compose exec` into that container, not an inherited
DATABASE_URL. Each checkout gets a non-superuser owner role and a private database;
the bootstrap administrator installs pgvector before application migrations run.
The server and migrations receive the same generated connection string. Database
identity and passwords are validated before they can become provisioning SQL.

Existing env files are never copied or modified. Generated credentials under
`.data/dev/instance.json` are mode 0600 and persist across setup runs. The runner
sets database, auth secrets, blob root and desktop profile in the child environment,
overriding inherited values before Vite loads any env files. Direct package scripts
are deliberately lower-level: they do not provide this safety boundary. Integration
tests still own their separate Testcontainers databases.

Database rows and blob bytes belong together. Instances start empty, but the explicit
`dev:import` command can copy a personal snapshot from `apps/web/.env`, falling back
to the primary checkout’s file for a linked worktree. Relative blob paths resolve
at that source checkout. The source is read-only; its encryption key is reused so
provider ciphertext needs no rewrite. These remain real provider credentials.

Import restores into a fresh database and copies blobs into a fresh directory.
Migration history must match the checkout, and every referenced blob must match
its recorded size and digest. Sessions and OAuth tokens are cleared, OAuth providers
are disabled, and active generation, research and indexing work is terminalized
before activation. A non-empty snapshot without a password account is refused,
since disabling OAuth would remove its sign-in path. One atomic manifest rename
selects the new database, blobs, profile and key together. Failure before activation
leaves the previous selection intact; older generations are retained, not deleted.
Electron sets its checkout-local userData path before services capture paths or
sessions open. The installed desktop profile stays untouched.

Setup is explicit and idempotent, with role/database creation serialized by an
advisory lock. T3 Code’s worktree hook invokes that same command; runtime correctness
does not depend on which tool created the checkout. Normal startup does not migrate.

Stopping a runner signals only process groups it spawned; `dev:stop` retires the
registered runtime through the lock socket and waits for its cleanup to acknowledge.
Import and migration commands refuse to run while a runtime is registered, and
`pg_stat_activity` provides the belt-and-braces check against unregistered tools.
Shared Postgres and the
Portless proxy remain running. There is intentionally no automatic destructive
cleanup hook: removing a Git worktree does not drop its database. Before retiring an
instance, record its name with `pnpm dev:info`, stop its processes, and deliberately
drop only that database and role from the dedicated dev container. Keep its state
until the database is discarded. Never use `docker compose down --volumes` for
per-worktree cleanup: the dev volume contains every checkout’s database.
