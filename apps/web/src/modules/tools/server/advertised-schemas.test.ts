import { Effect } from "effect";
import { Tool, type Toolkit } from "effect/unstable/ai";
import { describe, expect, it } from "vitest";
import { prepareAgentDraftTools } from "~/modules/agents/server/authoring-tools.ts";
import { prepareDocumentTools } from "~/modules/documents/server/document-tools.ts";
import { saveMemoryTool } from "~/modules/memory/server/memory-tool.ts";
import { prepareProjectFileTools } from "~/modules/projects/server/file-tools.ts";
import { prepareScheduleDraftTools } from "~/modules/schedules/server/authoring-tools.ts";
import { askUserTool } from "./ask-user.ts";
import { updatePlanTool } from "./plan-tool.ts";

const guard = () => Effect.void;
const base = { userId: "u", conversationId: "c", messageId: "m", writeGuard: guard };
// Building a toolkit may list what exists; an empty answer for every method is enough here.
const emptyService = new Proxy({}, { get: () => () => Effect.succeed([]) });
const emptyServices = new Proxy({}, { get: () => emptyService });
const toolsOf = (toolkit: Toolkit.Any): Tool.Any[] =>
  Object.values((toolkit as { tools: Record<string, Tool.Any> }).tools);

/**
 * These tools decode their arguments leniently in the handler, so the schema
 * the model sees comes from an annotation. When that annotation is dropped
 * the model is offered parameters with no type at all, and smaller models
 * then call the tool with nothing; every property must describe itself.
 */
describe("tool parameters the model is offered", () => {
  it("give every property of every lenient tool a real schema", async () => {
    const documents = await Effect.runPromise(
      prepareDocumentTools({ ...base, service: { list: () => Effect.succeed([]) } as never }),
    );
    const agentDrafts = await Effect.runPromise(
      prepareAgentDraftTools({ ...base, services: emptyServices as never }),
    );
    const scheduleDrafts = await Effect.runPromise(
      prepareScheduleDraftTools({ ...base, services: emptyServices as never }),
    );
    const projectFiles = prepareProjectFileTools({
      ...base,
      service: {} as never,
      generationId: "g",
      project: { id: "p", canEdit: true },
    });
    const tools = [
      ...toolsOf(documents.group.toolkit),
      ...toolsOf(agentDrafts.group.toolkit),
      ...toolsOf(scheduleDrafts.group.toolkit),
      ...toolsOf(projectFiles.group.toolkit),
      saveMemoryTool,
      askUserTool,
      updatePlanTool,
    ];
    const empty = tools.flatMap((tool) => {
      const properties = (Tool.getJsonSchema(tool) as { properties?: Record<string, object> })
        .properties;
      return Object.entries(properties ?? {})
        .filter(([, schema]) => Object.keys(schema).length === 0)
        .map(([key]) => `${tool.name}.${key}`);
    });
    expect(empty).toEqual([]);
  });

  it("tells the model edit_document takes text for old and new", async () => {
    const documents = await Effect.runPromise(
      prepareDocumentTools({ ...base, service: { list: () => Effect.succeed([]) } as never }),
    );
    const edit = toolsOf(documents.group.toolkit).find((tool) => tool.name === "edit_document")!;
    expect(Tool.getJsonSchema(edit)).toMatchObject({
      properties: { old: { type: "string", minLength: 1 }, new: { type: "string" } },
    });
  });
});
