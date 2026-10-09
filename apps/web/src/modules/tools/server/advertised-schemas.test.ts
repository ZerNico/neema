import { Effect } from "effect";
import { Tool, type Toolkit } from "effect/unstable/ai";
import { describe, expect, it } from "vitest";
import { prepareAgentDraftTools } from "~/modules/agents/server/authoring-tools.ts";
import { prepareDocumentTools } from "~/modules/documents/server/document-tools.ts";
import { saveMemoryTool } from "~/modules/memory/server/memory-tool.ts";
import { prepareProjectFileTools } from "~/modules/projects/server/file-tools.ts";
import { prepareScheduleDraftTools } from "~/modules/schedules/server/authoring-tools.ts";
import { preparePublishFileTool } from "~/modules/chat/server/publish-file.ts";
import { createWorkingFiles } from "~/modules/chat/server/working-files.ts";
import {
  editPresentationTool,
  inspectPresentationTool,
  renderPresentationTool,
} from "~/modules/presentations/server/tools.ts";
import { parsePresentationOperations } from "~/modules/presentations/operations.ts";
import {
  editSpreadsheetTool,
  inspectSpreadsheetTool,
} from "~/modules/spreadsheets/server/tools.ts";
import { editWordFileTool, inspectWordFileTool } from "~/modules/word/server/tools.ts";
import { askUserTool } from "./ask-user.ts";
import { prepareBrowserTools } from "~/modules/browser/server/tools.ts";
import { updatePlanTool } from "./plan-tool.ts";
import { notifyUserTool } from "~/modules/schedules/server/notify-tool.ts";

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
      ...toolsOf(preparePublishFileTool(createWorkingFiles()).group.toolkit),
      ...toolsOf(preparePublishFileTool(createWorkingFiles()).createGroup.toolkit),
      inspectPresentationTool,
      editPresentationTool,
      renderPresentationTool,
      inspectSpreadsheetTool,
      editSpreadsheetTool,
      inspectWordFileTool,
      editWordFileTool,
      saveMemoryTool,
      askUserTool,
      updatePlanTool,
      notifyUserTool,
      ...toolsOf(prepareBrowserTools({ rowIdFor: () => Effect.succeed(undefined) }).toolkit),
    ];
    // Schema.Number advertises "NaN" and "Infinity" as strings; models then send them.
    expect(JSON.stringify(tools.map((tool) => Tool.getJsonSchema(tool)))).not.toContain('"NaN"');
    const empty = tools.flatMap((tool) => {
      const properties = (Tool.getJsonSchema(tool) as { properties?: Record<string, object> })
        .properties;
      return Object.entries(properties ?? {})
        .filter(([, schema]) => Object.keys(schema).length === 0)
        .map(([key]) => `${tool.name}.${key}`);
    });
    expect(empty).toEqual([]);
  });

  it("keeps presentation top-level parameters optional and canonical selectors in runtime parity", () => {
    for (const tool of [
      inspectPresentationTool,
      editPresentationTool,
      renderPresentationTool,
      inspectSpreadsheetTool,
      editSpreadsheetTool,
    ]) {
      expect((Tool.getJsonSchema(tool) as { required?: string[] }).required ?? []).toEqual([]);
    }
    const schema = Tool.getJsonSchema(editPresentationTool) as {
      properties: {
        operations: {
          items: {
            anyOf: Array<{
              properties: {
                kind: { enum: string[] };
                placeholder?: { pattern: string; maxLength: number };
              };
            }>;
          };
        };
      };
    };
    const selector = schema.properties.operations.items.anyOf.find(
      (branch) => branch.properties.kind.enum[0] === "setText",
    )!.properties.placeholder!;
    expect(selector.maxLength).toBe(10);
    for (const name of [
      "title",
      "subtitle",
      "body",
      "body2",
      "body5",
      "body10",
      "body999999",
      "body1",
      "body0",
      "body02",
      "body1000000",
      "obj",
      "ctrTitle",
      "ftr",
      "body-2",
      "body2.0",
    ]) {
      const advertised =
        new RegExp(selector.pattern).test(name) && name.length <= selector.maxLength;
      const parse = () =>
        parsePresentationOperations([
          { kind: "setText", slideRef: "first", placeholder: name, text: "Text" },
        ]);
      if (advertised) expect(parse).not.toThrow();
      else expect(parse).toThrow(/placeholder/);
    }
  });

  it("tells the model edit_document takes a block id, a position and Markdown", async () => {
    const documents = await Effect.runPromise(
      prepareDocumentTools({ ...base, service: { list: () => Effect.succeed([]) } as never }),
    );
    const edit = toolsOf(documents.group.toolkit).find((tool) => tool.name === "edit_document")!;
    expect(Tool.getJsonSchema(edit)).toMatchObject({
      properties: {
        target: { type: "string", minLength: 1 },
        position: { enum: ["replace", "before", "after"] },
        find: { type: "string" },
        content: { type: "string" },
      },
    });
  });
});
