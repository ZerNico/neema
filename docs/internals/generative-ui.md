# Generative UI

An answer can contain ```` ```ui ```` blocks: Svelte-like markup the model writes, drawn with our own components. The block is part of the message text, so the live stream, a reload and a branch all carry it with no transport of their own. Logic in a block runs only inside QuickJS, and the page sees validated JSON.

## The language

- Markup: lowercase tags from the catalog (`src/modules/genui/catalog.ts`), `{expr}` interpolation, `{#each}` and `{#if}` blocks, and an optional leading `<script>` using Svelte 5 runes: `let x = $state(init)` declares persisted state, `const y = $derived(expr)` is recomputed on every render. It is our grammar, not Svelte: the Svelte compiler emits DOM code, which is exactly what must not run.
- No model is trained on it. A model learns it by loading the `builtin:interactive-ui` skill, whose catalog section is generated and whose examples a test renders (see [skills](skills.md)). Models write what they know from web pages, so the runtime also accepts habits such as JSX-cased events and `toLocaleString`.
- `parse.ts` is tolerant because it runs on every streaming render: an unfinished trailing tag or expression is dropped, open elements close at the end, mistakes become diagnostics. A half-written `<script>` stops parsing until it closes, so a block never runs a script whose end has not arrived.
- Block identity is the fence's ordinal among the message's `ui` fences (`fences.ts`), computed on the raw message text. Content only grows during a generation and is copied verbatim by branch and resume, so the ordinal is stable on every path. Citation rewriting changes text lengths, which is why the key is never derived from an offset in rewritten text.

## The mutation contract

A rebuilt block must equal the live one, because runtimes are evicted, workers restart and pages reload. The only state that survives is the `$state` JSON, so nothing else may change:

- `script.ts` rejects the whole script when any assignment, update or `delete` targets something other than a `$state` name, a member of a `$state` value, or a local declared inside a function. A rejected block renders as source.
- After the script runs, every other top-level value is deep-frozen (`__freeze` in the compiled block).
- Rendering reads a frozen copy of state through a proxy that throws on writes, so `{n = 5}` fails that expression and changes nothing.
- The clock is frozen at the message's `createdAt` (`now`, `Date.now()`, `new Date()`). A retry keeps the row, so its clock is the first attempt's. `random()` throws while rendering and is a seeded generator in handlers, its seed kept in state. QuickJS has no `Intl`, and no model is trained on this format, so they write `toLocaleString` and `Intl.NumberFormat` as in any web page. `intl-shim.ts` covers the everyday cases for the main locales and degrades anything else to plain formatting, never to a blank. It formats dates in UTC so every reader sees the same. `<num>` and `<date>` stay preferred: the host formats them in the reader's own locale.

## The boundary

- `compile.ts` emits one sloppy-mode function: `with (__derived) with (__state)` is what lets a handler write `gear = v`. `with` is illegal in modules, so it is evaluated as a global script.
- `runtime.ts` passes only strings: the prelude (`prelude.ts`) answers `render`, `call` and `state` with JSON. No host object or function is injected, and the host checks a string's length before parsing it.
- Every handler reference carries the render revision. A call from an older render is refused instead of running whatever now holds that index.
- Actions (`send`, `open`, `copy`) only queue during a handler, one per call. Which events may trigger which action, and what the host does with them, is the host's decision.
- Limits per block: 16 MB of memory, a 256 KB stack (larger, and deep recursion traps the whole WebAssembly module instead of throwing), deadlines of 200 ms for the script and handlers and 50 ms per render.
- `catalog.ts` validates every tree before React sees it: unknown tags and props are dropped, required props missing omit the node. Drawings are a closed SVG subset: geometry and theme colours only, no `href`, `style`, event attribute, `url()` or `foreignObject`.

## In the page

- One dedicated Worker per page holds every live block's runtime (`client/worker.ts`, `client/engine.ts`). Parsing, compiling, evaluation and catalog validation all run there, so the main thread only draws trees that already passed the catalog. At most 16 runtimes live at once, least recently used first out, and an evicted block's handlers answer as stale.
- The page's watchdog (`client/host.ts`) times a request only from the moment the Worker reports it started, so queueing never counts. A request still executing after a second terminates the Worker, and every block renders again in a fresh one from its source and last state. Handler references from before a restart are stale. A block that took the Worker down twice stays on its source.
- QuickJS compiles WebAssembly inside the Worker, and the document CSP stays as it is. A Worker loaded from a same-origin URL follows the CSP of its own response, never its creator's (only `blob:` and `data:` Workers inherit), and `/assets` responses carry none. A CSP added to `/assets` later, by a proxy for example, would need `'wasm-unsafe-eval'` in that header, not the document's. Checked in Chromium against the built Worker, with and without the directive on the page.
- Only `AssistantMarkdown` registers the renderer. Reasoning, file and skill previews show a block as code.
- `projectAssistantBody` treats a `ui` fence as one unit: an activity anchored inside it is shown after it, so a block never splits across two markdown renders. That is display only, and stored offsets stay as they are. `renderPart` writes each block's ordinal into its fence opener before citations are prepared, and the citation helpers skip `ui` fences, so a key never moves when the first source arrives and a `[^5]` in a script stays code.
- Streamdown remounts renderers when an answer finishes and the transcript virtualizes rows away. A block's last tree and state live outside React (`client/memory.ts`), keyed by message and ordinal. A source that extends the remembered one (still streaming) keeps its state, and one that replaces it (a retry) starts fresh.

## Actions

A block's code is model-written and can be prompt-injected through web content, so what its actions do is decided by the host (`ui-block.tsx`), never by the block:

- A user message carries the reader's authority: tools, integrations, memory, and URL authority for the reader. So a block never sends on its own. `send(text)` from a handler only fills the composer (`ComposerHandle.offerDraft`), and the reader sends.
- The one direct send is a `<suggestion>` chip: its label is the message, shown in full before the click. A label with a link or over 500 characters goes to the composer instead. It sends plain text with no composer files and no research offer, like a structured answer.
- Only clicks on a button act. A slider or input change can never send, open or copy. Suggestions and sends work only on the conversation's last answer, once it finished.
- Text with invisible characters (format characters such as zero-width or bidi marks and Unicode tags, except the joiner emoji need) is refused, and the catalog strips them from everything a block shows, so what the reader sees is what would be sent.
- `open(url)` goes through the leave dialog. `copy(text)` takes at most 4 KB and the toast shows what was copied.

## Saved state

- `message_ui_states` keeps one row per block (answer, ordinal) with the block's `$state` JSON and the hash of the block's code when saved. The reader's runtime reports state after each handler, and the save follows a second later.
- A save names the attempt (`generationId`). Under the conversation lock that retry and edit take, it is accepted only from the conversation's owner, for a finished answer still on that attempt, whose stored block at that ordinal hashes to the saved source. A late save from an attempt a retry replaced is refused, never stored. Retry and edit delete the rows in the reset that starts the new attempt.
- Stop, the reaper and resume keep the answer's text, so they keep its rows. A branch copies them. The loader returns them with every page of history, and the page applies a row only while its hash still matches the block.
- The model never sees widget state, so earlier answers stay byte-stable for prompt caching.

## Images

- Image tags carry a search query, never a URL. A block cannot point the page at an address of its choosing, and `img-src` stays `'self'`.
- The server resolves queries while the answer streams (`genui/server/image-resolver.ts`). It reads each fence once, when it closes, so a query is never searched mid-word. Only literal queries count (`extract.ts`): the server runs before any browser has evaluated the block. A computed query renders as unavailable.
- Resolution follows the search this attempt was offered: the sender's permission and the composer toggle. Without it each query is recorded as `search_off` and the tile says images need web search. Nothing is looked up.
- Fetching reuses the reader's SSRF boundary (resolve, pin, re-check each redirect). The body is capped, the type sniffed (never SVG), and the dimensions read from the header alone (`image-header.ts`). The server never decodes an image. Bytes are stored as fetched and only the reader's browser decodes them, so a hostile image never reaches native code in the server process.
- Each image is a `search_image` attachment claimed by the answer (see [files](files.md)), registered under the generation fence. Positions come from the maximum across all of the message's attachments, because answer files are written by another fiber. The outcome per query goes into `assistantOutput.images`, keyed by normalised query. That column also holds answer files, so every writer merges into it.
- Results are not chunks and take no `seq`. After each commit the engine publishes an `images` event with every result so far. A subscriber gets a snapshot read after it subscribes, so an image recorded between the loader and the subscription is never lost. The client merges by query, so a repeat changes nothing.
- On normal completion the answer waits up to five seconds for lookups in flight, inside the generation's scope, because recording needs the row still streaming. Stop, an error or a lost lease close the scope and interrupt them. Whatever is left is recorded as unavailable, and the reaper resolves nothing.
- A resume skips queries an earlier attempt settled, and the per-answer caps count both. A branch copies the images with fresh ids. Retry and edit release them with the old attempt's files.
