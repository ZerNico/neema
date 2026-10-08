# Generative UI

An answer can contain ```` ```ui ```` blocks: Svelte-like markup the model writes, drawn with our own components. The block is part of the message text, so the live stream, a reload and a branch all carry it with no transport of their own. Logic in a block runs only inside QuickJS, and the page sees validated JSON.

## The language

- Markup: lowercase tags from the catalog (`src/modules/genui/catalog.ts`), `{expr}` interpolation, `{#each}` and `{#if}` blocks, and an optional leading `<script>` using Svelte 5 runes: `let x = $state(init)` declares persisted state, `const y = $derived(expr)` is recomputed on every render. It is our grammar, not Svelte: the Svelte compiler emits DOM code, which is exactly what must not run.
- `parse.ts` is tolerant because it runs on every streaming render: an unfinished trailing tag or expression is dropped, open elements close at the end, mistakes become diagnostics. A half-written `<script>` stops parsing until it closes, so a block never runs a script whose end has not arrived.
- Block identity is the fence's ordinal among the message's `ui` fences (`fences.ts`), computed on the raw message text. Content only grows during a generation and is copied verbatim by branch and resume, so the ordinal is stable on every path. Citation rewriting changes text lengths, which is why the key is never derived from an offset in rewritten text.

## The mutation contract

A rebuilt block must equal the live one, because runtimes are evicted, workers restart and pages reload. The only state that survives is the `$state` JSON, so nothing else may change:

- `script.ts` rejects the whole script when any assignment, update or `delete` targets something other than a `$state` name, a member of a `$state` value, or a local declared inside a function. A rejected block renders as source.
- After the script runs, every other top-level value is deep-frozen (`__freeze` in the compiled block).
- Rendering reads a frozen copy of state through a proxy that throws on writes, so `{n = 5}` fails that expression and changes nothing.
- The clock is frozen at the message's `createdAt` (`now`, `Date.now()`, `new Date()`). A retry keeps the row, so its clock is the first attempt's. `random()` throws while rendering and is a seeded generator in handlers, its seed kept in state. QuickJS has no `Intl`, so locale formatting is the host's job (`<num>`, `<date>`).

## The boundary

- `compile.ts` emits one sloppy-mode function: `with (__derived) with (__state)` is what lets a handler write `gear = v`. `with` is illegal in modules, so it is evaluated as a global script.
- `runtime.ts` passes only strings: the prelude (`prelude.ts`) answers `render`, `call` and `state` with JSON. No host object or function is injected, and the host checks a string's length before parsing it.
- Every handler reference carries the render revision. A call from an older render is refused instead of running whatever now holds that index.
- Actions (`send`, `open`, `copy`) only queue during a handler, one per call. Which events may trigger which action, and what the host does with them, is the host's decision.
- Limits per block: 16 MB of memory, a 256 KB stack (larger, and deep recursion traps the whole WebAssembly module instead of throwing), deadlines of 200 ms for the script and handlers and 50 ms per render.
- `catalog.ts` validates every tree before React sees it: unknown tags and props are dropped, required props missing omit the node. Drawings are a closed SVG subset: geometry and theme colours only, no `href`, `style`, event attribute, `url()` or `foreignObject`.

## Images

Image tags carry a search query, not a URL. `extract.ts` finds literal queries in closed fences so the server can resolve them while the answer streams. A computed query renders as unavailable.
