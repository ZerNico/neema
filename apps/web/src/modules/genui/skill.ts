// The builtin skill that teaches a model to write ```ui blocks. No model is
// trained on this format, so the text carries the whole contract: grammar,
// the generated catalog, the rules the runtime enforces, and examples that
// `skill.test.ts` renders through the real engine.

import { catalogReference } from "./catalog.ts";

export const INTERACTIVE_UI_SKILL_ID = "builtin:interactive-ui";

/** Each example is a complete block body; the test renders every one. */
export const SKILL_EXAMPLES = {
  calculator: `<script>
  const sprockets = [28, 24, 21, 18, 16, 14, 12];
  let gear = $state(4);
  let cadence = $state(80);
  const ratio = $derived(42 / sprockets[gear - 1]);
  const speed = $derived(ratio * 2.1 * cadence * 60 / 1000);
</script>
<card title="Gear calculator">
  <row justify="between">
    <title size="sm">Gear {gear} of 7</title>
    <badge tone="primary"><num value={ratio} format="decimal:2"/> : 1</badge>
  </row>
  <slider label="Gear" min={1} max={7} value={gear} onchange={(v) => gear = v}/>
  <stepper label="Cadence (rpm)" value={cadence} min={40} max={120} step={5} onchange={(v) => cadence = v}/>
  <row gap={2} wrap>
    {#each sprockets as teeth, i}
      <badge tone={i + 1 === gear ? "primary" : "muted"}>{teeth}T</badge>
    {/each}
  </row>
  <stat label="Speed" value={speed.toFixed(1) + " km/h"}/>
</card>`,
  comparison: `<script>
  const plans = [
    { name: "Basic", price: 8, storage: 50 },
    { name: "Plus", price: 15, storage: 200 },
    { name: "Pro", price: 29, storage: 1000 },
  ];
  let yearly = $state(false);
  let picked = $state([]);
  const cost = (plan) => yearly ? plan.price * 10 : plan.price;
  function toggle(name) {
    const at = picked.indexOf(name);
    if (at === -1) picked.push(name);
    else picked.splice(at, 1);
  }
</script>
<box gap={3}>
  <switch label="Pay yearly (two months free)" checked={yearly} onchange={(v) => yearly = v}/>
  <tabs>
    <tab label="Table">
      <table columns={["Plan", yearly ? "Per year" : "Per month", "Storage"]}
        rows={plans.map((p) => [p.name, "$" + cost(p), p.storage + " GB"])}/>
    </tab>
    <tab label="Chart">
      <chart type="bar" label="Price per plan" x={plans.map((p) => p.name)}
        series={[{ name: "Price", values: plans.map(cost) }]} unit="$"/>
    </tab>
  </tabs>
  <row gap={2}>
    {#each plans as plan}
      <button variant={picked.includes(plan.name) ? "default" : "outline"} onclick={() => toggle(plan.name)}>{plan.name}</button>
    {/each}
  </row>
  {#if picked.length > 1}
    <callout tone="info">Comparing {picked.join(" and ")}.</callout>
  {:else}
    <text tone="muted">Pick two plans to compare.</text>
  {/if}
</box>`,
  drawing: `<script>
  let percent = $state(65);
  const angle = $derived(-90 + percent * 1.8);
</script>
<box gap={2}>
  <svg viewBox="0 0 200 110" label="Battery health gauge" height={140}>
    <path d="M 10 100 A 90 90 0 0 1 190 100" fill="none" stroke="muted" strokeWidth={12}/>
    <g transform={"translate(100 100) rotate(" + angle + ")"}>
      <line x1={0} y1={0} x2={0} y2={-80} stroke="primary" strokeWidth={4}/>
    </g>
    <circle cx={100} cy={100} r={6} fill="primary"/>
    <text x={100} y={70} textAnchor="middle" fontSize={18} fill="currentColor">{percent}%</text>
  </svg>
  <slider label="Health" min={0} max={100} value={percent} onchange={(v) => percent = v}/>
  <images query={["lithium ion battery cell cutaway", "battery health screen iphone"]} layout="grid" aspect="4:3"/>
</box>`,
  plan: `<script>
  let guests = $state(6);
  let done = $state([]);
  const lamb = $derived((guests * 0.4).toFixed(1));
</script>
<card title="Sunday roast">
  <stepper label="Guests" value={guests} min={2} max={12} onchange={(v) => guests = v}/>
  <stat label="Bone-in leg of lamb" value={lamb + " kg"}/>
  <copy text={"Lamb " + lamb + " kg, potatoes " + guests * 250 + " g, carrots " + guests}>Copy shopping list</copy>
  <steps checkable done={done} onchange={(d) => done = d}>
    <step title="Prep ahead" time="Saturday">Make the crumble and the marinade.</step>
    <step title="Start roasting" time="1:30 PM">Into the oven, check with a thermometer.</step>
    <step title="Rest and carve" time="4:45 PM">Rest 30 minutes, then carve.</step>
  </steps>
  <timer seconds={1800} label="Resting"/>
</card>`,
  map: `<script>
  let stop = $state("museum");
</script>
<map label="A day in Potsdam" selected={stop} onselect={(id) => stop = id}>
  <pin id="station" place="Potsdam Hauptbahnhof" label="Station">Trains from Berlin every 10 minutes.</pin>
  <pin id="museum" place="Museum Barberini, Potsdam" label="Barberini" color="chart-2">Impressionists, closed Tuesdays.</pin>
  <pin id="palace" place="Sanssouci Palace" label="Sanssouci" color="chart-3">Book the palace tour ahead.</pin>
  <route mode="walk" stops={["Potsdam Hauptbahnhof", "Museum Barberini, Potsdam", "Sanssouci Palace"]} label="Walk"/>
</map>`,
} as const;

const fence = (body: string) => "```ui\n" + body + "\n```";

export const INTERACTIVE_UI_SKILL_DESCRIPTION =
  "How to put interactive UI in an answer with a ```ui block: calculators, comparisons, charts, drawings, maps and image galleries.";

export const INTERACTIVE_UI_SKILL_ROOT = `---
name: interactive-ui
description: ${INTERACTIVE_UI_SKILL_DESCRIPTION}
---

# Interactive UI

An answer may contain \`\`\`ui fenced blocks. Each is drawn in the chat with the app's own components and can hold state the reader changes: sliders, toggles, tabs, steppers. Use one when interaction or a visual makes the answer clearer than prose: a calculator, a comparison the reader filters, a chart, a small diagram, a gallery. Keep explanations in normal Markdown around the block. Most answers need no block.

## Language

- A block is markup: \`<tag prop="text" prop={expression} flag/>\`, plain text, and \`{expression}\` interpolation. Tags are only those in the catalog below; anything else is dropped.
- Logic: \`{#each list as item, i}…{:else}…{/each}\` and \`{#if cond}…{:else if other}…{:else}…{/if}\`.
- An optional \`<script>\` comes first. \`let x = $state(initial)\` declares state the reader changes. \`const y = $derived(expression)\` is recomputed on every render. Plain \`const\` and \`function\` declarations are allowed.
- Events: \`onclick={() => …}\` on buttons and on drawing shapes, \`onchange={(value) => …}\` on inputs. The argument is the new value. A tappable shape needs a \`label\` saying what it selects; it can change state but never send, open or copy.
- Text is plain: no Markdown, no citations, no HTML. Use \`<b>\`, \`<i>\`, \`<code>\`, \`<link>\` inline.

## Rules the runtime enforces

- Only \`$state\` variables may be assigned or mutated (\`n++\`, \`items.push(x)\`, \`form.name = v\`). Writing anything else rejects the whole block, and it is shown as source. Inside \`{#each items as item, i}\`, write through the state (\`items[i].done = true\`), never to \`item\`. Keep everything the reader changes in \`$state\`: a \`Set\`, \`Map\` or closure variable is lost when the block reloads.
- Rendering is pure: state changes only inside event handlers. \`random()\` and \`Math.random()\` work only in handlers. \`now\` and \`Date.now()\` are the answer's creation time, fixed.
- There is no network, no DOM and no \`window\`, and scripts have no timers: for a countdown or stopwatch use \`<timer>\`, which counts in the page. Handlers may call \`send(text)\` (puts a message in the composer for the reader to send), \`open(url)\` and \`copy(text)\`, one per click.
- \`toLocaleString\` covers common cases, but \`<num>\` and \`<date>\` format in the reader's own locale and are better.
- Images: \`<image query>\` and \`<images query>\` are found by web search when the answer finishes writing the block. Write queries as literal strings; a computed query is never searched. Without web search the reader sees a note instead.
- Maps: \`<pin place>\` and \`<route stops>\` names are looked up on OpenStreetMap when the block is finished, so write each place as a literal, specific enough to find ("Museum Barberini, Potsdam", not "the museum"). Give \`lat\` and \`lng\` instead when you know them exactly. Routes drive, walk or bike along real roads; \`mode="straight"\` is a direct line, for flights or distances. A place that cannot be found is listed as such, never guessed.
- \`<suggestion>\` text is sent as the reader's next message when clicked. Leave them out unless the answer ends at a real fork the reader has to choose, such as which option to explore next. Most blocks need none, and the reader can always just type.
- Up to 8 blocks per answer, 32 KB each. A failing expression blanks only its own spot.

## Catalog

${catalogReference()}

## Examples

A calculator with derived values:

${fence(SKILL_EXAMPLES.calculator)}

A comparison with tabs, a chart and a helper that mutates state:

${fence(SKILL_EXAMPLES.comparison)}

A drawing with images:

${fence(SKILL_EXAMPLES.drawing)}

A plan with a checklist, a copy button and a timer:

${fence(SKILL_EXAMPLES.plan)}

A map whose pins the reader taps:

${fence(SKILL_EXAMPLES.map)}
`;
