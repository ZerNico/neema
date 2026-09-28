# Custom tools

Admins author TypeScript modules in `/admin/custom-tools`. A plain chat offers
every enabled module the sender may use; an agent narrows that to the modules it
attached, each contributing every callable function. Custom tools run through the
ordinary Effect toolkit loop, so native provider tool calling and the Hermes
fallback see the same definitions and results.

## Trust model

Custom tool source and installed dependencies are **trusted server code**. They can
read files and environment variables, make network requests, open database
connections, start subprocesses, or terminate the process. Worker threads protect
the chat event loop from a stuck invocation; they are not a security sandbox or a
permission boundary.

Creation, editing, dependency installation, checking and testing all require an
admin session. Being offered a module grants no new authority to the user: it only
lets the model choose whether to invoke code an admin already installed.

A deadline covers queueing, module initialization, argument validation, handler
execution and result serialization. Timeout or cancellation terminates and
replaces the worker. Termination cannot undo filesystem, network, database, or
subprocess side effects that already happened, and may not stop a subprocess the
tool detached.

## Authoring contract

`@chat/custom-tools` is a build-only virtual module. Effect Schema is the single
source of truth for TypeScript argument inference, provider JSON Schema and
runtime decoding:

```ts
import { Schema, defineModule, defineTool } from "@chat/custom-tools";
import ky from "ky";

export default defineModule({
  current_weather: defineTool({
    name: "Current weather",
    description: "Get the current weather for a city.",
    parameters: Schema.Struct({
      city: Schema.String.annotate({ description: "City name" }),
      units: Schema.optional(Schema.Literals(["metric", "imperial"])),
    }),
    run: async ({ city, units }) =>
      ky
        .get("https://example.test/weather", {
          searchParams: { city, units },
        })
        .json(),
  }),

  geocode: defineTool({
    name: "Geocode city",
    description: "Resolve a city name to coordinates.",
    parameters: Schema.Struct({ city: Schema.String }),
    run: async ({ city }) => ({ city, latitude: 0, longitude: 0 }),
  }),
});
```

A module and each function use lowercase slug segments. The model-facing name is
`custom_<module-slug>__<function-slug>`. Both slug components are capped at 27
characters, keeping the complete name within the common 64-character provider
limit. The `custom_` prefix is the durable family discriminator in persistence
and client projection. Inside a generation, though, the manifest that generation
resolved decides what counts as a custom call: a model can invent a `custom_…`
name, and the SDK still forwards that part to the consumer, so a prefix test
there would turn a hallucination into a failed attempt. A name outside that
manifest falls through like any other unknown tool.

Build inspection converts each parameter schema with
`Schema.toJsonSchemaDocument`, preserving `$defs`. A struct annotated with an
`identifier` comes back as a bare root `$ref`; providers require `type:
"object"` at the root of tool parameters, so that definition is inlined and
only nested references stay as `$defs`. Invocation decodes unknown
model arguments through the same schema before calling `run`. Validation and
handler failures use `failureMode: "return"`, so they become bounded model-visible
results instead of failing the generation.

Result normalization is strict. Strings pass through, `undefined` becomes empty
text, and other JSON values are pretty-printed. BigInt, functions, symbols,
cycles, nested `undefined`, non-finite numbers and serialization failures return
`ok: false`. The serialized output is bounded before it crosses the worker
boundary.

## Dependencies and builds

The editor accepts registry package names with exact versions. Ranges, tags,
aliases, git/URL/file/workspace specs, duplicate roots, `effect`, and
`@chat/custom-tools` are rejected. The server installs dependencies into a
private temporary npm project with Arborist, lifecycle scripts disabled, and the
same 24-hour minimum-release-age policy as the workspace. The module keeps its
declared exact versions; with every root pinned, that is enough to rebuild it.

The build then:

1. runs the app-pinned TypeScript compiler in strict no-emit mode;
2. bundles source and declared npm dependencies into one CommonJS Rolldown chunk;
3. externalizes only Node built-ins and the app-pinned Effect runtime;
4. rejects extra chunks, emitted assets, unresolved externals and oversized output;
5. inspects the emitted module in the worker runtime and stores its function
   manifest and provider schemas.

A failed Verify, Debug or Save never replaces the stored module. Runtime invocation reads
only the stored bundle and never consults npm, the registry, or the build cache.
The external-module rule is for reproducibility, not containment.

A bundle carries the authoring runtime it was built with, so a runtime change reaches a
module only when it is saved again. Nothing rebuilds a module at invocation: that would
consult the registry. Where an old bundle meets a contract it predates, the worker fails that
call with a message telling an admin to save the tool again. Today that is a returned file
without `delivery`, which only a bundle from before delivery existed can produce.

`@chat/custom-tools` itself is `authoring.ts`, bundled by the Vite plugin and
inlined into every authored module; its ambient types are
`authoring-declaration.ts`. The two are kept in step by `builder.test.ts`,
which compiles a real module against both.

The build links the app's own Effect over `node_modules/effect` so the bundle
shares one runtime with the host. A dependency that itself depends on `effect`
would have that copy silently retargeted to another major, so the installer
refuses the tree instead.

Lifecycle scripts and native addons are unsupported. Packages that need runtime
`node_modules`, dynamically constructed package imports, or unbundled filesystem
assets are also unsupported. Registry credentials are operator configuration,
not an admin-UI feature.

## Modules and attempts

`custom_tools` is one row per module: identity, source, exact dependencies, the
bundle and its function manifest. A save replaces the row and issues a new
`version`; the editor sends the version it loaded, and a save against another
one is refused, so two admins cannot overwrite each other. The slug is editable
like any other field, and a save always rebuilds because the model-facing names
are derived from it during inspection; a rename that only rewrote the column
would leave the stored manifest naming functions the attempt no longer offers.
Deleting a module deletes the row, freeing its slug, since attachments and
grants cascade and no answer depends on it. Nothing is versioned: an assistant answer
that ran an older build keeps what it needs (display name, result preview, file
ids) on its own tool-call row, the way web and desktop tool rows do, and the
bytes that ran are not retrievable afterwards. That is the same trade every
other tool family makes, and it is what lets the model stay one table.

`agent_custom_tools` narrows an agent's offer to explicit modules; with no agent
installed the attempt resolves `"all"`. A module is shared like an agent or
skill, through `SharingService` and the same Access dialog: `audience` is
`instance` (everyone signed in, the default) or `private`, with
`custom_tool_user_grants` and `custom_tool_group_grants` on top. Admins always
pass the feature grant, and any admin may manage a module's access since modules have no owner.
Other senders also need the [custom-tool grant](feature-policy.md) in addition to the module ACL.
The check (`customToolUsableBy`) runs in SQL at attach time and again on every attempt,
against the person sending rather than the agent's owner, so a shared agent
carries no tool to someone it was not shared with: the module drops out of that
sender's offer the way a disabled one does.

A slug therefore names one module at a time rather than across all of history: a
rename frees the old identifier for another module, so two tool-call rows from
different eras can carry the same `custom_…` name. They still read and replay
correctly, each carrying its own display name and result, but "which module ran
this" has no answer once the module is renamed or deleted. That is the same
trade every other tool family makes, and history is what the reader needs.

Attempt resolution reads the enabled, usable modules inside the same
transaction that creates or resets the assistant attempt and holds them in the
in-memory `GenerationConfig` for the life of that generation. A running generation
is therefore unaffected by an edit or deletion mid-flight; the next retry, edit or
new turn resolves the modules again as they are then. Reload and branch carry
nothing here, since a tool-call row is self-describing. Deleting the creating
admin does not delete modules.

Tool page bodies and source are never persisted in tool-call rows. The continuation
transcript receives the normalized result, while durable activity stores only a
bounded preview, character count and bounded error.

## Files

`run` may return `{ text?, files }` where every entry comes from
`file(bytes | string, { name, mediaType?, delivery, showModel?, replaces? })`.
`delivery` is required: `"working"` creates an attempt-local revision or replaces
an exact `working:<id>@<revision>` reference; `"publish"` delivers a finished
attachment during this call. Only working outputs may use `replaces`. The brand
is a symbol, so an object that merely resembles a file is ordinary JSON. Files
cross the worker boundary on the transfer list beside the text; the worker
enforces count and byte caps (`CUSTOM_TOOL_LIMITS.files`, `fileBytes`,
`totalFileBytes`).

Working outputs are not persisted as attachments while the answer runs. The host
returns a canonical reference for each accepted output, and a later tool can consume its
exact revision through `fileInput`; only the module that created a draft may replace it.
Its type is classified from the bytes, never taken from `mediaType`. A rejected output is
reported individually,
not advertised as saved; published outputs go through the same fenced registration
as `publish_file`. Only publishing consumes the answer's file budget and produces
a `file` chunk and downloadable assistant attachment. Those survive reloads and
branches. An unpublished draft is kept for later answers in the chat that offer the same
module; see [files](files.md#files-into-tools).

`showModel: true` independently puts accepted bytes in front of the model on the
next round when supported; it does not save a second file. The durable tool row
holds bounded result/working status and accepted attachment IDs, never the bytes
or full output. Delivered attachments render after the tool row without another
chip inside it. A published attachment ID can be passed to `save_to_workspace`
in Work or `save_project_file` in a project chat. An admin Test has no chat to
publish into: its bounded returned bytes come back inline as `data:` URLs with
stated delivery intent, without claiming a persistent reference.

## File inputs

`fileInput({ description?, accept? })` is a parameter the model fills with a
string, a canonical file reference or name, and `run` receives as a `ToolInputFile`
(`name`, `mediaType`, `size`, `bytes`, `ref`, `text()`). The build writes the model-facing
description; `accept` takes extensions or media types.

- The schema decodes the string by asking the host, so a file parameter works at
  any depth and only files a call actually names are loaded. The worker posts a
  `file` message mid-call; the pool answers from the job's resolver and transfers
  a fresh copy of the bytes. The job's deadline keeps running meanwhile.
- The resolver (`chat/server/tool-files.ts`) is built per answer and bounded by
  the sender: exact attempt-local working revisions, files in this chat (attached or
  produced), then the current version of a project file in a project chat. Chat
  attachments inherited by a branch resolve through its alias map before the
  current-chat ownership check. An id matches before a name; among equal names
  the newest chat file wins. A lookup that fails, or a file `accept` refuses,
  becomes the decode error the model reads, never a failed answer.
- Per call, at most `inputFiles` files and `inputFileBytes` together. The result
  lists what the call read, with a project file's id and version, so the model can
  save an edited copy as the next version.
- Test has no chat: the admin picks files in the dialog and the arguments name
  them. They exist for that one run, so their `ref` is a `working:` reference, the
  kind an answer's own short-lived files carry.

## Worker lifecycle

A process-wide runtime owns a small fixed worker pool. Each worker runs one job at
a time and caches loaded modules by bundle hash, so warm calls avoid reparsing and
rerunning module top-level code. `vm.Script.runInThisContext` is only the CommonJS
loader. The main runtime owns cancellation and deadlines; replacing a worker also
clears its module state. Any exit the pool did not request, including a tool
calling `process.exit(0)`, fails the running job at once and respawns the slot
rather than waiting for the deadline on a thread that no longer exists.

Module globals are therefore an opportunistic cache, not persistence. Timeout,
cancellation, cache eviction, deployment, HMR or process restart may reload the
module at any time. Durable state belongs in an explicit external system chosen by
the trusted admin.

Deep-research workers do not receive custom tools. They investigate a brief with
their own fixed web toolkit and never inherit the host conversation’s agent tools.
