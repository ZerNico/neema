// What a block shows, in a line per control, for the next answer to read beside
// its $state. The state holds the reader's raw inputs; this holds what the
// page made of them: the result a calculator shows, a quiz's score, the
// distance a map's route came to. Only these lines' shape is ours: labels and
// values are the model's and the reader's, so the context calls it data.

import type { UiLookups } from "~/modules/chat/assistant-output.ts";
import type { ValidNode } from "../catalog.ts";
import { resolveMap, routeSummary } from "./map-model.ts";

export const DIGEST_LIMITS = {
  chars: 1_000,
  valueChars: 200,
} as const;

type Child = ValidNode | string;

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const cut = (text: string) =>
  text.length > DIGEST_LIMITS.valueChars ? `${text.slice(0, DIGEST_LIMITS.valueChars)}…` : text;
/** Numbers as a person reads them: no float noise from arithmetic in a block. */
const shown = (value: unknown): string | undefined =>
  typeof value === "number"
    ? String(Number(value.toFixed(6)))
    : typeof value === "string"
      ? cut(value)
      : undefined;
const nodes = (children: readonly Child[]) =>
  children.filter((child): child is ValidNode => typeof child !== "string");

/** The label an option list shows for a value. */
function optionLabel(options: unknown, value: unknown): string | undefined {
  if (!Array.isArray(options)) return shown(value);
  for (const option of options) {
    if (option === value) return shown(option);
    if (typeof option === "object" && option !== null && "value" in option && option.value === value)
      return "label" in option ? shown(option.label) : shown(value);
  }
  return shown(value);
}

const MODE = { drive: "Drive", walk: "Walk", bike: "Bike", straight: "Direct" } as const;

function mapLines(node: ValidNode, lookups: UiLookups): string[] {
  const model = resolveMap(node, lookups, false);
  const lines: string[] = [];
  const name = str(node.props.label) ?? "Map";
  const picked = model.pins.find((pin) => pin.id === str(node.props.selected));
  lines.push(`${name}${picked ? `: selected ${picked.label}` : ""}`);
  const routeNodes = nodes(node.children).filter((child) => child.tag === "route");
  model.routes.forEach((route, i) => {
    const stops = routeNodes[i]?.props.stops;
    const names = Array.isArray(stops)
      ? stops.map((stop) => (typeof stop === "string" ? stop : "a point")).join(" → ")
      : "";
    const summary = routeSummary(route, "en");
    const legs = route.status === "ready" ? lookupLegs(lookups, route.key) : [];
    lines.push(
      `${route.label ?? MODE[route.mode]} route ${names}: ${
        summary ?? (route.status === "ready" ? "drawn" : "unavailable")
      }${legs.length > 1 ? ` (legs: ${legs.join(", ")})` : ""}`,
    );
  });
  const missing = model.pins.filter((pin) => pin.status === "missing").map((pin) => pin.label);
  if (missing.length > 0) lines.push(`Not found on the map: ${missing.join(", ")}`);
  return lines;
}

function lookupLegs(lookups: UiLookups, key: string): string[] {
  const route = Object.hasOwn(lookups.routes, key) ? lookups.routes[key] : undefined;
  return (route?.legs ?? []).flatMap((leg) => routeSummary(leg, "en") ?? []);
}

function linesOf(node: ValidNode, lookups: UiLookups): string[] {
  const p = node.props;
  const label = str(p.label);
  switch (node.tag) {
    case "slider":
    case "number":
    case "stepper":
    case "input": {
      const value = shown(p.value);
      return value === undefined ? [] : [`${label ?? node.tag}: ${value}`];
    }
    case "select":
    case "choice":
    case "segmented": {
      const value = p.value === undefined ? undefined : optionLabel(p.options, p.value);
      return value === undefined ? [] : [`${label ?? node.tag}: ${value}`];
    }
    case "checkbox":
    case "switch":
      return [`${label ?? node.tag}: ${p.checked === true ? "on" : "off"}`];
    case "stat": {
      const value = shown(p.value);
      return value === undefined ? [] : [`${label ?? "stat"}: ${value}`];
    }
    case "progress":
      return [`${label ?? "progress"}: ${shown(p.value)}%`];
    case "quiz": {
      const questions = nodes(node.children).filter((child) => child.tag === "question");
      const answers = Array.isArray(p.answers) ? p.answers : [];
      const answered = answers.filter((answer) => answer !== null && answer !== undefined).length;
      const right = questions.filter((q, i) => answers[i] === q.props.answer).length;
      return [
        `${str(p.title) ?? "Quiz"}: ${answered} of ${questions.length} answered, ${right} right`,
      ];
    }
    case "steps": {
      if (p.checkable !== true) return [];
      const total = nodes(node.children).filter((child) => child.tag === "step").length;
      const done = Array.isArray(p.done) ? p.done.length : 0;
      return [`Steps: ${done} of ${total} done`];
    }
    case "wizard": {
      const steps = nodes(node.children).filter((child) => child.tag === "step");
      const current = typeof p.current === "number" ? p.current : 0;
      const step = steps[current];
      return step ? [`Step ${current + 1} of ${steps.length}: ${shown(step.props.title)}`] : [];
    }
    case "tabs": {
      const tabs = nodes(node.children).filter((child) => child.tag === "tab");
      const open =
        tabs.find((tab) => p.value !== undefined && (tab.props.value ?? tab.props.label) === p.value) ??
        tabs[0];
      return open ? [`Tab open: ${shown(open.props.label)}`] : [];
    }
    case "map":
      return mapLines(node, lookups);
    default:
      return [];
  }
}

/** Containers whose own lines would repeat what their children say. */
const LEAVES = new Set(["quiz", "map", "steps", "wizard"]);

/**
 * The block's lines, in reading order, within the budget: when too long, the
 * longest lines go first, since a short pick says more per character.
 */
export function digestTree(tree: readonly Child[], lookups: UiLookups): string | null {
  const lines: string[] = [];
  const walk = (children: readonly Child[]) => {
    for (const node of nodes(children)) {
      lines.push(...linesOf(node, lookups));
      if (!LEAVES.has(node.tag)) walk(node.children);
    }
  };
  walk(tree);
  const kept = lines.map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const size = () => kept.reduce((sum, line) => sum + line.length + 1, 0);
  while (kept.length > 0 && size() > DIGEST_LIMITS.chars) {
    const longest = kept.reduce((max, line, i) => (line.length > kept[max]!.length ? i : max), 0);
    kept.splice(longest, 1);
  }
  return kept.length > 0 ? kept.join("\n") : null;
}

