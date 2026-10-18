# Citations and markdown rendering

Citations are synthesized GFM footnotes, not model-written links, and every `<Streamdown>` renderer shares one
plugin config because highlighting, math, mermaid and CJK handling are opt-in and fail silently without it.

## Citations

- Citations ride on GFM footnotes (`[^N]`), not markdown links: a half-streamed `[text](htt` renders as an
  unoverridable `[blocked]` span (streamdown rejects an undefined href _before_ consulting `components.a`),
  while `[^1` is just literal text.
- The model writes markers only. We synthesize the `[^N]: url` definitions from the tool's own source list
  (`prepareCitedMarkdown`, `src/modules/chat/ui/citations.ts`) — without them GFM leaves `[^1]` as raw text
  until the definitions arrive, i.e. never mid-stream.
- Two streamdown 2.6.0 output details are load-bearing: the `#user-content-fn-N` href on a footnote ref, and
  the `data-footnotes` attribute on the appended section. hast gives that attribute the _empty string_, so
  suppress on `!== undefined` — a truthiness check silently renders the list. Pinned by `message-list.test.tsx`.
- A citation chip is a link to its source showing favicon and site (a document or service source shows its
  title instead); the page title and snippet wait in its hover card, since a title in every chip ran to the
  chip's limit on every line. The number is never rendered, in chips or in the sources panel. Markers, source manifests and the panel's row keys all use the number.
- Adjacent markers (`[^2][^5]`) are rewritten to one reference labelled `2-5`, with a synthesized definition
  pointing at the first source, so they render as one chip with a "+1" count and every source on hover.
  `FOOTNOTE_HREF` parses that label; the sources panel still reads the model's raw markers. The prompt asks
  for a marker per paragraph or list item, not per sentence: the chip is visual weight, and a chip on every
  line of an answer drawn from one page buries the prose.
- Citation numbers are conversation-scoped: `createSourceIndexer` is seeded from prior messages' persisted
  sources and shared by all web tools in a generation, so repeats keep their number and every tool continues
  one sequence.
- `tools/sources.ts` merges observations everywhere: successful extraction is monotonic, and a later search
  cannot replace it with snippet-only evidence. Sources panel/counts select own cited or extracted sources
  plus cited inherited sources, never all search hits.
- The client resolves an inherited number through one merged history per number (`inheritSources`), never
  a copy of every earlier source per message. A chat opens with only its latest turns, so an answer may cite
  a number an unloaded turn registered: every detail window and older page carries `priorSources`, the
  earlier sources its own text cites, and they seed that history.

## Markdown plugins (`src/ui/markdown-plugins.ts`)

- Streamdown 2.x ships highlighting, math, mermaid and CJK handling as opt-in plugins. Without them a fence
  renders as unstyled plain text, `$$…$$` stays literal, and a CJK autolink swallows the punctuation after it
  — all silently, with no error. One shared config feeds all three `<Streamdown>` call sites.
- `katex` is a direct dependency only for its stylesheet: streamdown never calls the math plugin's
  `getStyles()`, so `app.css` imports it. Keep it on the same major as the renderer — `rehype-katex@7` pins
  `katex@^0.16`, so a float to 0.17+ styles markup that 0.16 produced.
- The math plugin overrides remark-math's default to `singleDollarTextMath: false`; leave it there. Enabled,
  "It costs $5 and $10" renders as the expression "5and".
- mermaid is ~950 KB gzipped and `@streamdown/mermaid` imports it at module scope, so it is wrapped in a lazy
  stand-in — streamdown only needs `getMermaid()` synchronously and awaits `render()`, where the dynamic
  import happens. Re-exporting the upstream plugin directly would put all of mermaid in the eager chat chunk.
- Diagrams render behind an `IntersectionObserver` + `requestIdleCallback` gate, so they stay blank in a
  browser-automation tab that never paints; the fullscreen button takes the `immediate` path and renders
  regardless.
