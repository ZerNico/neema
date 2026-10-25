import { Effect, Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";
import { AgentDraftToolName } from "~/modules/agents/tool-schema.ts";
import { OFFICE_FAMILIES } from "~/modules/office/families.ts";
import { ScheduleDraftToolName } from "~/modules/schedules/tool-schema.ts";
import { parseIntegrationToolName } from "~/modules/integrations/manifest.ts";
import {
  integrationToolFamily,
  LazyToolFamily,
  LoadToolsResult,
  type LoadableToolFamily,
} from "../tool-load-schema.ts";
import { advertisedParameter, type ToolGroup } from "./toolset.ts";

/** Each lazy family's tool names, the unit `load_tools` makes available. */
export const LAZY_FAMILY_TOOLS: Record<LazyToolFamily, ReadonlyArray<string>> = {
  presentation: OFFICE_FAMILIES.presentation.names.literals,
  spreadsheet: OFFICE_FAMILIES.spreadsheet.names.literals,
  word: OFFICE_FAMILIES.word.names.literals,
  "agent-draft": AgentDraftToolName.literals,
  "schedule-draft": ScheduleDraftToolName.literals,
};

/** One line each, in the catalogue the model chooses from. */
const LAZY_FAMILY_SUMMARIES: Record<LazyToolFamily, string> = {
  presentation: "Create, inspect, edit and render PowerPoint decks (.pptx).",
  spreadsheet: "Create, inspect and edit Excel workbooks (.xlsx) with live formulas.",
  word: "Create, inspect and edit Word files (.docx), including templates, when the person asks for one or gives you one.",
  "agent-draft": "Draft a new saved agent or edit an existing one for the user to save.",
  "schedule-draft": "Draft a scheduled task that runs a prompt on a recurring schedule.",
};

/** The family a tool belongs to: a fixed one, or its integration's, whether or not that is lazy here. */
export const lazyFamilyOfTool = (name: string): LoadableToolFamily | null => {
  const fixed = LazyToolFamily.literals.find((family) => LAZY_FAMILY_TOOLS[family].includes(name));
  if (fixed) return fixed;
  const integration = parseIntegrationToolName(name);
  return integration ? integrationToolFamily(integration.integrationId) : null;
};

/** The catalogue line of a fixed family; an integration's comes from its tools. */
export const fixedFamilySummary = (family: LazyToolFamily) => LAZY_FAMILY_SUMMARIES[family];

/** Whether a toolkit tool's schema is shown: always, unless its family is offered unloaded. */
export const isAdvertised = (
  name: string,
  offered: ReadonlyArray<LoadableToolFamily>,
  unlocked: ReadonlySet<LoadableToolFamily>,
) => {
  const family = lazyFamilyOfTool(name);
  return !family || !offered.includes(family) || unlocked.has(family);
};

/**
 * The catalogue sits in the stable prefix, so it names every family the
 * attempt offers whether or not it is loaded yet: loading never rewrites it.
 */
export const toolLoadPolicy = (
  offered: ReadonlyArray<{ readonly family: LoadableToolFamily; readonly summary: string }>,
) =>
  [
    "More tools are available on request. Call load_tools with the families a task needs before you start on it; their tools can be used from your next step and stay available for the rest of this chat. Load only what the request calls for.",
    ...offered.map(({ family, summary }) => `- ${family}: ${summary}`),
  ].join("\n");

/** Its enum is what this attempt offers, which the catalogue lists in the same order. */
const loadToolsTool = (offered: ReadonlyArray<LoadableToolFamily>) =>
  Tool.make("load_tools", {
    description:
      "Make one or more tool families from the system prompt's list available. Their tools appear from your next step and stay for the rest of this chat.",
    parameters: Schema.Struct({
      families: advertisedParameter({
        type: "array",
        items: { type: "string", enum: [...offered] },
        minItems: 1,
      }),
    }),
    success: LoadToolsResult,
  });

/**
 * `unlocked` belongs to the attempt and only grows: a family loaded once stays
 * advertised for the rest of the answer, whatever later compaction drops.
 */
export const prepareToolLoad = (input: {
  offered: ReadonlyArray<LoadableToolFamily>;
  unlocked: Set<LoadableToolFamily>;
}): ToolGroup => ({
  family: "tool-load",
  toolkit: Toolkit.make(loadToolsTool(input.offered)),
  handlers: {
    load_tools: (args: { families?: unknown }) =>
      Effect.sync(() => {
        const requested = Array.isArray(args.families)
          ? args.families.filter((name): name is string => typeof name === "string")
          : [];
        const offered = new Set<string>(input.offered);
        const loaded = input.offered.filter((family) => requested.includes(family));
        for (const family of loaded) input.unlocked.add(family);
        return {
          loaded,
          unavailable: requested.filter((name) => !offered.has(name)),
        } satisfies LoadToolsResult;
      }),
  },
});
