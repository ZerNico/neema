# UI conventions

Primitives are shadcn-generated (Base UI, style `base-luma`) and regenerated via the CLI, not hand-rolled.
Shared components exist because a screen once reimplemented one and drifted; bypassing them reintroduces
that bug.

## Primitives and generation

- Regenerate primitives (`src/ui/primitives`) via `pnpm dlx shadcn@latest add <component>`, don't
  hand-roll. The CLI asks to overwrite `button.tsx` on every add (registry dependency) — answer no. It
  also adds `next-themes` whenever a component's upstream reads the theme (`sonner`) — remove it and wire
  `~/ui/theme.tsx` instead, as `sonner.tsx` does.
- `src/styles/app.css` must keep `@import "tw-animate-css"` and `@import "shadcn/tailwind.css"` right
  after `@import "tailwindcss"`: overlay primitives' `data-open:animate-in`/`fade-in-0`/`zoom-in-95`
  classes come from `tw-animate-css`, and without it overlays pop with no transition and no error. `cn`
  (the package) is re-exported by `src/ui/utils.ts`; primitives import `"cn"` directly, as the CLI emits.
- In-page cards import from `~/ui/card.tsx`, not the generated primitive; floating overlays keep their
  generated elevation instead. `DropdownMenuLabel` is a Base UI `GroupLabel` and throws outside a
  `Group`/`RadioGroup` — for a plain hint line in a menu, render a static `<p>`. Never `<Button
render={<Link/>} nativeButton={false}>` for navigation — Base UI forces `role="button"`; use `<Link
className={buttonVariants({...})}>`.
- Radius scale is 2xl/3xl/4xl for app-authored chrome only, not generated primitive density or
  chart/favicon geometry. Semantic colour tokens only — `success`/`warning` exist beside `destructive`.

## Page chrome and layout

- Browser and Electron share a client-rendered SPA. The root document is a generic shell, not a
  personalized SSR page. Early scripts apply theme and native-control clearance before paint; one
  permanent titlebar target survives hydration. A client-only boundary mounts desktop detection and
  theme-dependent UI before the application, so controls do not first render browser defaults. The
  document response sets a Content-Security-Policy: production hashes those two boot scripts,
  development leaves Vite's inline preamble and HMR socket room. Auth checks and route loaders
  still use authorized server functions. Startup shows `StartupPending`.
  Uncaught route errors and unmatched URLs go through TanStack Start’s root
  `errorComponent` / `notFoundComponent` and the matching router defaults
  (`src/ui/route-error.tsx`), which reuse `ErrorState` / `EmptyState`; a
  conversation 404 stays on that route’s own `notFoundComponent`. Route loading
  must not replace the authenticated background Work host.
- Page chrome lives in `src/ui/page-shell.tsx` (`SectionShell`, `Page`, `Section`, `ListCard`/`ListRow`,
  `EmptyState`, `ErrorState`), used across admin, settings, tools, agents, knowledge and the chats index.
  **`Page` is the scroll container**: the app layout's `<main>` is a fixed-height flex child that never
  scrolls, because the chat view pins its composer/virtual list to that height. Every other route needs
  its own scroller; never nest another `overflow-y-auto` inside `Page`. On a capable desktop, viewport
  shells use the available height below the document’s native-control row. Fixed sidebar and sheet
  surfaces reserve that row once; the detail rail stays in normal flex layout. Browser sizing is
  unchanged. Pinned by `page-shell.test.tsx` and the desktop chrome tests.
- Loading a page's data is the **route loader's** job (`ensureQueryData`, or `prefetchQuery` + `retry:
false`), so a page body is written against data already there. This includes local Electron folder
  state needed for the first Work composer render: client loaders await it in the same QueryClient
  the view consumes. Local failures remain inline and retryable rather than failing the chat route.
  Where a loader can't cover it, `ListSkeleton` (`page-shell.tsx`) is the one pending shape, never a
  bare `null` or `animate-pulse` div.
- Buttons go in exactly two places, chosen by what the button does: `Section`'s `actions` slot (top-right)
  is for "add one of these"; `FormActions` (`page-shell.tsx`) is the row under the fields, for
  Save/Apply/Reset. Skip it and a submit button that's a direct child of a `flex-col` form stretches full
  width — how the agent editor got a full-bleed Save.

## Buttons and pending state

- A pending button keeps its label; a spinner slides in ahead of the text, never replacing it. Exactly two
  ways to write one — `PendingButton` (`src/ui/pending-button.tsx`) for a plain mutation, `form.SubmitButton`
  for TanStack Form, which renders through `PendingButton` so the two can't drift. `aria-busy` is always
  `x || undefined` — absent when idle, never `aria-busy="false"`.
- A dropdown item is the exception: it closes on activation, so it can't carry a spinner and `disabled` is
  the pending signal, unless it sets `closeOnClick={false}` to stay open (account menu). `Spinner` is
  `role="status"` on its own — pass `aria-hidden` where a control already has a label or `aria-busy`, or
  assistive tech announces "Loading" twice.

## The detail panel

- `DetailPanelRequest` has an `actions` slot the shell renders pinned under the panel
  header, outside the scroller, and a `body` it renders inside. A body must never pin
  itself: the desktop rail and the mobile sheet pad their scrollers differently, so a
  body sticking to the scroll edge can only be right in one of them, and the agent draft
  spent two rounds of negative margins learning that. Actions that submit a form in the
  body reach it with the `form` attribute rather than moving back inside it.

## Errors and confirmations

- Inline errors are `FieldError` (`role="alert"` + destructive text, null when empty) — override size with
  `className`, don't re-derive colour/role on a `<p>`. Non-inline failures stay `toast.error` ("Could not
  <verb> the <thing>."); confirmations go through `useConfirm()` (AlertDialog).
- Access is managed through `sharing/ui/access-dialog.tsx`, not link copying. `SharingService.recipients`
  is a deliberate account directory readable by any signed-in user — fits a single-tenant self-hosted
  deployment and exposes nothing else about an account. Every grant is the same permission, so rows carry
  a plain "Can use" label, never a role picker the backend can't honour. Audience is additive (direct
  grants, groups, everyone signed in can overlap), so removing one grant never implies other access ended.
  Broadening to everyone confirms first; narrowing does not, since it takes nothing away that was granted
  directly.

## Words on screen

- Say a thing once per screen. A `Section` with a heading usually needs no `description`; a
  field with a label usually needs no helper. Where helper text only repeats the label, the
  icon, or the control beside it, delete it rather than shortening it — `EmptyState`'s
  `description` is optional for exactly this reason.
- Name what the reader can act on, not the part that failed. "Provider", "stream", "context",
  "run", "instance", "generation attempt", "indexing", "embeddings" are internals: they
  describe machinery nobody using the app can do anything about. `generation-failure.ts` is
  the shared map for terminal failures and should stay in reader vocabulary.
- Confirmations are the exception to brevity: the consequence is the thing being confirmed, so
  a destructive dialog earns its sentence. Sharing scope is the same — who else can see this is
  worth spelling out.
- Progressive disclosure over deletion when detail is genuinely useful but rarely needed: a
  plain summary with the rest folded away, as in the "Technical details" disclosure on a failed
  answer and "About usage" on the usage page.
- `/settings/usage` has no admin guard: it renders the same `usage-dashboard.tsx` as the admin
  analytics page, so anything worded there is ordinary-user copy.
- One state, one word. A document being prepared says "preparing" in the knowledge pages, the
  collection page and the composer's picker; it used to say "indexing" in one of the three.

## Icons and text

- Every `HugeiconsIcon` carries `strokeWidth={2}` (package default 1.5) so one weight never appears twice
  on a screen. Inside a `Button`, `DropdownMenuItem` or `Badge` the variant already sizes the svg — don't
  add `className="size-4"` there, it defeats the `xs`/`icon-xs` sizes.
- "New X" opens a creation surface; "Create X" is the commit inside it. A resource's own name in a confirm
  title is wrapped in curly quotes (`Delete "${name}"?`) because it is user-authored; a person's name is
  not (`Ban ${name}?`). Copy uses curly apostrophes (`isn't`, `Couldn't`) — a straight one next to a curly
  one in the same transcript is the bug this prevents. Model-facing prompt strings are exempt.

## Chat-specific pieces

- The web-search toggle rests on a default (`useSearchMode(defaultEnabled)`): true in plain chat,
  the installed or selected agent's "web search by default" otherwise. A manual flip is one
  message's opt-in or opt-out and resets on send; picking another agent in a new chat resets it
  too. The deep-research toggle sets `researchEnabled` only, leaving that search preference
  intact while its own control is hidden. Opening a conversation or new chat focuses the
  composer, except on a phone (`useIsMobile`), where it would raise the keyboard over what the user came
  to read.
- Agent Create/Edit with chat uses a one-shot TanStack history-state text prefill, not a query
  string, automatic send or hidden launch RPC. Consume only the app’s state key without
  remounting the composer or overwriting input typed before consumption; SSR has no browser
  history state. An edit link names the target, never copies its private instructions or installs
  it as the conversation’s agent.
- Transcript activity for an editable conversation resource opens its detail; it never owns the
  editor or auto-opens the panel. `AgentDraftOwner` and `DocumentOwner` mount one controller per
  known id at conversation level, above the virtualiser, so a widget scrolling out of view, a
  panel replacement or a removed tool row cannot take local edits with it. Widgets only look the
  controller up by id. Owners refresh only the selected detail and publish only visible entry
  changes, rather than letting every fresh controller object replace panel state.
- Loader summaries, matching persisted rows, live activity and sync discover owned editors. The
  same owned-id predicate enables the controller and flush-before-action gate. Transcript recovery
  widgets keep canonical resources reachable after retry/edit removes their tool rows. Branch
  references stay historical and inert even if the branch later acquires a resource of its own.
- Agent-draft reconciliation accepts clean remote fields and disjoint edits, but differing edits
  to one field require an inline choice. Conversation-document source uses whole-document CAS:
  clean source adopts a remote revision, while dirty source shows **Keep mine** and **Take theirs**.
  Document task ticks patch their own source line optimistically and serialize behind source saves.
  A document panel is read-only while its assistant answer is generating. Flush every owned editor
  before send, structured answer, retry, edit, branch or save, never Stop. A document belongs to its
  creating answer, so rewinding that answer removes it; its rich card stays at the creating tool
  call's text offset, never in a transcript footer. The manual agent editor similarly pins its dirty
  baseline rather than treating a background refetch as permission to overwrite newer settings.
- Upload-queued composer sends sample in two moments, on purpose. What the person decided by
  pressing Submit (`onSend`, the research offer, the blocked/disabled state, the model) is frozen at the
  click; what they can still edit while uploads settle (draft text, skill chips) is read at dispatch.
  `Composer` keeps one effect-updated request ref for both and copies it at the click; see
  `docs/internals/desktop.md` for the mode-fixed rule this serves.
- `activityRowClassName` (`src/modules/chat/ui/activity-row.ts`) is the one-line transcript summary row,
  sitting beside `disclosureTriggerClassName` — a message stacks both. Chat disclosures use
  `~/ui/disclosure.tsx` for measured-height/opacity animation, reduced-motion and hidden-until-found
  handling; keep each consumer's open state, timers and scroll behavior local.
