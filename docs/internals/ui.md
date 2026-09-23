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
- `@shadcn/lint` enforces the rule this file opens with: a call site may lay a component out, tint it to
  a semantic foreground, reveal it and say how its text fills the box, but changing a component's own
  spacing, shape or type scale means the wrong component was chosen or a variant is missing. That list
  is `callSiteMayDo` in `oxlint.config.ts`; `Card` and its parts also take padding, because `card.tsx`
  is shared by padded cards and unpadded ListCards. `no-restyle` exempts `src/ui/**`, where the
  design system restates its own primitives, and component tests. Unknown-class checking still runs
  there; only `test-panel-class` in the detail-panel test and the generated Sonner `toaster` class
  are allowed in their respective files. Raw-color checking remains enabled everywhere.
- Stacked form sections use `FieldSet` from `~/ui/field-set.tsx` with `compact` for tighter spacing;
  the generated primitive and the wrapper's default keep their original spacing.
- It runs at `error` with a count of zero, so anything new is genuinely new. The standing exceptions
  each carry an `oxlint-disable-next-line` naming the reason, next to the line it applies to. Add one
  there rather than widening `callSiteMayDo`, which would hide the decision from everyone who reads
  that line later.
- Only `no-restyle`, `no-raw-colors` and `no-unknown-classes` are enabled; the plugin's rules are opt
  in. `no-arbitrary-values` and `no-inline-styles` were tried and dropped: this app needs viewport math,
  mask gradients and Base UI's anchor variables, and its inline styles hold measured values a class
  cannot carry, so between them the two wanted sixty exemptions to catch two real magic numbers.
  `require-static-classes` cannot see through a variable, so it rejects the shared row constants every
  activity block composes.
- Three surfaces exist only because several screens had each rebuilt them inline, which is the drift this
  file warns about: `segmented-control.tsx` (the pill form of a toggle group — the primitive's own shape
  is a joined bar), `hover-card.tsx` (a preview on hover — `TooltipContent` is a small inverted label,
  not a card) and `focus-ring.ts` (the ring a focusable surface takes when it is not a Button, which
  carries its own). `--radius-composer` is the composer's corner, off Tailwind's scale, with
  `--radius-composer-inner` the concentric radius for anything sitting `inset-1` within it.
- `Button` already has an `xs` size (24px tall). Reach for it before writing `h-6` and a padding
  override; five call sites in the folder strip had hand-rolled it while the size went unused.

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
- Where the primary action lives depends on how long the page is. A long editor (agent, skill, custom
  tool: several sections, a code or package workspace, scrolls) puts Save in `Page.actions` at the
  top-right, beside the record's own controls (Enabled, Access, the overflow menu), disabled until dirty; the reader may be editing anywhere on the page and Save has to be
  findable without hunting. A short form that fits on screen (profile, password, tool settings, model
  order) puts Save in `FormActions` (`page-shell.tsx`), the row under its fields, since reading
  top-to-bottom ends there. Skip `FormActions` and a submit button that's a direct child of a `flex-col`
  form stretches full width. `Section`'s `actions` slot (top-right of the section) is for "add one of
  these" and for verbs on that section's content (Verify and Debug on a custom tool's Source), never for
  Save. Dialogs always end in `DialogFooter`, Cancel then the primary on the right. A header Save that
  submits a form in the body reaches it through the `form` attribute, as the draft panel's does.

## Buttons and pending state

- A pending button never changes size: its label fades out in place and a spinner sits over it, so
  neither it nor its neighbours move (a spinner sliding in ahead of the text made the button grow, and
  its animated padding jittered). The label only goes transparent, so it still names the button. Exactly two
  ways to write one — `PendingButton` (`src/ui/pending-button.tsx`) for a plain mutation, `form.SubmitButton`
  for TanStack Form, which renders through `PendingButton` so the two can't drift. `aria-busy` is always
  `x || undefined` — absent when idle, never `aria-busy="false"`.
- Saving in place confirms in place, inside the button: `SaveLabel` (`src/ui/save-status.tsx`) turns the
  label into "✓ Saved" for a moment, both labels sharing one grid cell so the width never changes, and
  `SaveStatus` beside it says the same to screen readers. There is no separate "Unsaved changes" text: an
  enabled Save already says it, and text appearing in the header row moved everything. A toast is for a
  result that lands elsewhere or later (a run started, an import, access changed), and a created item's
  own page is its confirmation.
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
  `className`, don't re-derive colour/role on a `<p>`. A failed request is reported with
  `toastError(title, error)` (`src/ui/error-toast.ts`): the title is always the plain "Could not <verb>
  the <thing>."; a reason the server sent becomes the description; anything else (network, a bug in the
  page) adds nothing. Confirmations go through `useConfirm()` (AlertDialog).
- A server function never answers with a raw exception: driver errors can carry SQL or the content being
  written. `reportUnexpectedFailures` (`src/server/unexpected-failure.ts`, registered for every function in
  `src/start.ts`) lets deliberate `Response`s through and turns anything else into a logged failure under
  a short reference. The client sees `src/server-error.ts`'s fixed body and offers "Copy details" with that
  reference, so a report can be matched to its log line. Modules therefore map only their own rejections.
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
- A concept someone meets in the app (agents, knowledge, skills, schedules, memory) gets an entry in
  `modules/help/features.ts`. That list is the welcome tour, the "New in neema" tour for existing users
  and the Help page at once; seen keys live in `user_seen_features`, so never rename a shipped key.
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

- A message about an agent or schedule carries a Markdown link to its page (`[this schedule](/schedules/<id>)`):
  that is how the model finds the ID. `modules/chat/references.ts` is the one parser: the composer, the edit
  box and the sent bubble show a chip plus the link's own words, and the composer puts the link back on send,
  so the stored text, retry and branch are unchanged.
- The web-search toggle rests on a default (`useSearchMode(defaultEnabled)`): true in plain chat,
  the installed or selected agent's "web search by default" otherwise. A manual flip is one
  message's opt-in or opt-out and resets on send; picking another agent in a new chat resets it
  too. Deep research is a checkbox in the plus menu and nothing else — the two are independent
  offers now, so it never takes the search pill's place or hides it, and its own state is read
  where it is set. An edit carries its own offer, cleared each time an editor opens, because an
  edit is a fresh submission rather than a continuation. Opening a conversation or new chat focuses the
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
- A file an answer produced, a model's image or a custom tool's return, sits at the text offset
  where it appeared (`assistant-body.ts` orders it with the tool rows): images inline, anything
  else as the same `AttachmentChip` a sent message uses, opening the shared preview dialog. The
  tool row that produced it does not repeat the chip: the two would sit a line apart and read
  as two files.
- `activityRowClassName` (`src/modules/chat/ui/activity-row.ts`) is the one-line transcript summary row,
  sitting beside `disclosureTriggerClassName` — a message stacks both. Chat disclosures use
  `~/ui/disclosure.tsx` for measured-height/opacity animation, reduced-motion and hidden-until-found
  handling; keep each consumer's open state, timers and scroll behavior local.
