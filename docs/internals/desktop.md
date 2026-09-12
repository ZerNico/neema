# Work chats and the desktop shell

The site can act on the user's own machine, but only from inside the desktop
app (`apps/desktop`), which loads the deployed site and lends it a folder over
`contextBridge`. This page records the decisions that cross the three
packages: the shell, the shared contract (`packages/desktop-rpc`) and the web
app. Field lists and control flow live beside the code.

## The server never touches the machine

A desktop tool handler does not do the work. It registers the call with
`ExternalCompletion` (`apps/web/src/modules/tools/server/external-completion.ts`),
the loop announces the call on the message stream the page already subscribes
to, the page runs it through the bridge and reports back through
`submitDesktopToolResult`. `streaming.ts` sees an ordinary `tool-call` and an
ordinary `tool-result`; the multi-turn loop, prompt folding and the Hermes
polyfill never learn where the work happened.

Three consequences that are easy to break:

- **The wait is bounded because the lease cannot end it.** The flusher renews
  `generation_lease_until` every 250 ms whether or not anything is happening,
  so a handler blocked forever renews forever and the row becomes unreapable.
  `DESKTOP_TIMEOUTS` resolves as a value the model can read, never an exception.
- **The slot opens when the row is written, not when the handler waits.** A
  fast machine answers before the handler a step behind it starts waiting; an
  answer with no slot is dropped and reads as a hang.
- **Bytes never persist.** `forTranscript` keeps an excerpt of the detail and
  drops a `file` outright. An image or PDF a read produced becomes a user file
  part on the next round (the same path an attachment takes in `prompt.ts`) and
  is stripped from the tool result the model sees, the row and every chunk.

## Mode is fixed at creation; the folder lives on the machine

`conversations.mode` is `chat | work`, chosen when the chat starts, inherited
by a branch, never changed. A work chat sent to without a folder is refused
inside the turn (`WorkFolderRequired`) before any row is written, so the rule
holds even when the composer is bypassed.

The server stores only the folder's _name_ per attempt
(`message_generation_config.desktop_folder`), never a path. The path-to-
conversation mapping is `folders.json` in the desktop profile. This is what
makes the same chat correct on a second machine: it has no mapping, so it asks
for a folder, rather than trusting a path that means nothing there. A browser
tab reads a work chat and cannot continue it.

## Two srt quirks the wrapper corrects on macOS

`SandboxManager.wrapWithSandboxArgv` returns `bash -c "env HTTPS_PROXY=http://localhost:PORT … sandbox-exec …"`,
but the Seatbelt profile it generates denies the resolver lookup that
`getaddrinfo("localhost")` needs. curl and npm special-case the name; Python's
urllib3 does not, so `pip` fails with "nodename nor servname provided" before
it reaches the proxy. `forSandboxedChild` rewrites every proxy variable in that
script to `127.0.0.1` and points `PIP_CACHE_DIR` inside the folder, which is
the only writable path. Proven against the real sandbox: `pip download` through
the proxy succeeds, an off-allowlist host gets `403`, `~/.ssh` and a write
outside the folder get `Operation not permitted`.

The proxy that answers CONNECTs reads the manager's _global_ config, while the
per-call `customConfig` only shapes the Seatbelt profile. The network level
therefore goes through `updateConfig` before each run as well as into the
per-call override, or the two disagree and the level does nothing.

## Containment is the desktop's job; the sandbox is the second fence

Every path the site names goes through `resolveInFolder` (`apps/desktop/src/folders.ts`):
absolute paths refused outright, the nearest existing ancestor `realpath`-ed,
containment checked on the real path. A move checks both ends. `find_files`
and `search_files` walk without following symlinks for the same reason. Commands
run through `@anthropic-ai/sandbox-runtime` with the folder as the only writable
path, and the containment check has already happened before `run` is called.

## Policy is the chat's; only the path is the machine's

`conversations.network_level` (`packages` by default: npm, PyPI, crates, Go,
GitHub; or `none`, `all`) and `conversations.permission_level` (`auto` by
default; `manual`, `skip`) are facts about the chat, not about a device, so
they live on the server like `mode` and every machine honours the same choice.
The page carries the network level down with each command; the desktop stores
nothing but `conversationId → path` in `folders.json`, the one thing that
genuinely differs per machine. The same three network levels Claude Cowork
offers; Cowork defaults to _all_ on personal plans, this app to _packages_,
because a reader who never opens the picker should get the narrower policy.

## Search uses ripgrep when the machine has it

Bundling `rg` means a native binary per platform that macOS will not run
unsigned, which drags in packaging. So `ripgrep.ts` shells out to whatever
`rg` is on `PATH` and `walk.ts` answers otherwise. Both honour `.gitignore`
even outside a git checkout (`--no-require-git`), skip `.git`, never follow
symlinks and skip binaries in search; the handler tests run against both
backends so a result never depends on which one answered.

## Consent lives in the page

The page holds the call, so a refusal is enforced by the work never happening.
`useDesktopApprovals` keeps a per-conversation level on this machine
(`manual` asks for everything, `auto` asks before changes, `skip` asks for
nothing) and per-kind blanket grants (edit, command). Two rules do not bend:
a **delete** is asked about at every level and is never covered by a blanket,
and a blanket for edits never covers commands. The approval card is pressable
while the message is still `streaming`, the inverse of the clarification
card's gate, because the generation is parked on the answer rather than ended
by it.

## Edits are strict on purpose

`edit_local_file` requires an exact match, unique unless `all` is set, and
returns a unified diff. No whitespace normalisation, no first-match fallback,
no patch format: measured across many models, a sharp refusal the model can
widen its anchor from fails less than any of those.
