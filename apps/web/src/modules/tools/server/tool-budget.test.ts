import { Effect } from "effect";
import type { Tool, Toolkit } from "effect/unstable/ai";
import { describe, expect, it } from "vitest";
import { prepareAgentDraftTools } from "~/modules/agents/server/authoring-tools.ts";
import { estimateToolSchemaTokens } from "~/modules/chat/server/compaction.ts";
import { preparePublishFileTool } from "~/modules/chat/server/publish-file.ts";
import { createWorkingFiles } from "~/modules/chat/server/working-files.ts";
import { prepareDocumentTools } from "~/modules/documents/server/document-tools.ts";
import { saveMemoryTool } from "~/modules/memory/server/memory-tool.ts";
import {
  editPresentationTool,
  inspectPresentationTool,
  renderPresentationTool,
} from "~/modules/presentations/server/tools.ts";
import { prepareScheduleDraftTools } from "~/modules/schedules/server/authoring-tools.ts";
import {
  editSpreadsheetTool,
  inspectSpreadsheetTool,
} from "~/modules/spreadsheets/server/tools.ts";
import { editWordFileTool, inspectWordFileTool } from "~/modules/word/server/tools.ts";
import { askUserTool } from "./ask-user.ts";
import { updatePlanTool } from "./plan-tool.ts";
import { urlReaderTool } from "./url-reader.ts";
import { webSearchTool } from "./web-search.ts";

const guard = () => Effect.void;
const base = { userId: "u", conversationId: "c", messageId: "m", writeGuard: guard };
const emptyService = new Proxy({}, { get: () => () => Effect.succeed([]) });
const emptyServices = new Proxy({}, { get: () => emptyService });
const toolsOf = (toolkit: Toolkit.Any): Tool.Any[] =>
  Object.values((toolkit as { tools: Record<string, Tool.Any> }).tools);
const tokens = (tools: ReadonlyArray<Tool.Any>) =>
  estimateToolSchemaTokens({ tools: Object.fromEntries(tools.map((tool) => [tool.name, tool])) });

/**
 * Every schema offered up front is paid on each uncached request and crowds
 * the model's choice. Custom and integration tools are admin-sized and left
 * out; this pins what the application itself offers a plain chat.
 */
describe("the tools a plain chat is offered", () => {
  it("stay within the schema budget", async () => {
    const documents = await Effect.runPromise(
      prepareDocumentTools({ ...base, service: { list: () => Effect.succeed([]) } as never }),
    );
    const agentDrafts = await Effect.runPromise(
      prepareAgentDraftTools({ ...base, services: emptyServices as never }),
    );
    const scheduleDrafts = await Effect.runPromise(
      prepareScheduleDraftTools({ ...base, services: emptyServices as never }),
    );
    const offered = [
      ...toolsOf(documents.group.toolkit),
      ...toolsOf(agentDrafts.group.toolkit),
      ...toolsOf(scheduleDrafts.group.toolkit),
      ...toolsOf(preparePublishFileTool(createWorkingFiles()).group.toolkit),
      inspectPresentationTool,
      editPresentationTool,
      renderPresentationTool,
      inspectSpreadsheetTool,
      editSpreadsheetTool,
      inspectWordFileTool,
      editWordFileTool,
      webSearchTool,
      urlReaderTool,
      saveMemoryTool,
      askUserTool,
      updatePlanTool,
    ];
    // Today's measurement; loading Office and drafting tools on request
    // brings what a plain chat advertises far below this.
    expect(tokens(offered)).toBeLessThanOrEqual(26_000);
  });
});
