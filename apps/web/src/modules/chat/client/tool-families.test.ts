import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { imageActivity, runningImageActivity } from "~/modules/images/tool-schema.ts";
import { OFFICE_FAMILIES } from "~/modules/office/families.ts";
import { ToolChunkEnvelope } from "~/modules/tools/schema.ts";
import { toActivity } from "../ui/stored-activities.ts";
import { TOOL_FAMILIES } from "./tool-families.ts";
import { applyToolChunk, type ToolActivity } from "./use-message-stream.ts";

type Family = ToolActivity["family"];
type Body = Record<string, unknown>;

/**
 * One call as the server leaves it twice: the row it writes and the envelopes
 * it streams. Each body mirrors the emitter in `chat/server/generation/observe.ts`
 * (or the research runner), and every envelope must decode as the server's
 * declared `ToolChunkEnvelope`, so a fixture cannot drift from that contract.
 */
interface Case {
  family: Family;
  label: string;
  name: string;
  status: "complete" | "error";
  /** The row's `result` column once the call settled. */
  result: unknown;
  error?: { code: string; message: string };
  arguments?: unknown;
  /** What the row holds while running; null for every family but image and research. */
  running?: unknown;
  /** Start envelope fields beyond the shared header and placement. */
  start: Body;
  /** Progress and result envelope fields beyond the header, in stream order. */
  events: Body[];
  lineage?: { runId: string; taskId: string };
}

const progress = (phase: "researching" | "complete" | "error") => ({
  runId: "run-1",
  title: "Heat pumps",
  phase,
  tasks: [{ id: "t1", ordinal: 1, title: "Prices", status: "complete" as const }],
  limitations: [],
  usageComplete: true,
});
/** Every research envelope restates where its call sits. */
const researchPlacement = { runId: "run-1", turnIndex: 1, callIndex: 2, textOffset: 5 };
const source = {
  kind: "web" as const,
  index: 1,
  url: "https://example.com",
  title: "Example",
  snippet: "An example.",
  read: true,
};
const questions = [
  {
    question: "Which city?",
    options: [{ label: "Berlin" }, { label: "Paris" }],
    multiSelect: false,
  },
];
const route = {
  v: 1,
  outcome: "routed",
  mode: "walk",
  stops: [
    { query: "A", found: true, name: "A", lat: 1, lng: 2 },
    { query: "B", found: true, name: "B", lat: 3, lng: 4 },
  ],
  distance: 1200,
  duration: 900,
  legs: [{ distance: 1200, duration: 900 }],
} as const;
const image = { model: "gpt-image", editing: false, aspectRatio: "1:1", requested: 2 };
const customActivity = {
  family: "custom",
  version: 1,
  name: "custom_math__add",
  displayName: "Add",
  status: "complete",
  resultPreview: "3",
  resultChars: 1,
};
const integrationActivity = {
  family: "integration",
  version: 1,
  name: "int_jira__create_issue",
  integrationId: "jira",
  tool: "create_issue",
  label: "Create issue",
  access: "write",
  summary: "Bug",
  status: "complete",
  link: { title: "BUG-1", url: "https://jira.example.com/BUG-1" },
} as const;
const { link: _link, ...unlinked } = integrationActivity;
const refusedIntegration = { ...unlinked, status: "refused", error: "Declined." };
const skillActivity = {
  family: "skill",
  version: 1,
  name: "read_skill_file",
  skillId: "s1",
  skillName: "Brand",
  path: "colors.md",
  status: "complete",
} as const;
const desktopResult = { v: 1, ok: true, summary: "Read a.ts", detail: "…", truncated: false };
const knowledgeSummary = {
  targets: ["refunds"],
  documentsListed: 0,
  passagesReturned: 2,
  remainingOps: 3,
  coverage: "complete",
};
const word = OFFICE_FAMILIES.word.summary(
  { outcome: "working", message: "Draft updated.", workingFileId: "w1", revision: 2 },
  false,
);
const sheet = OFFICE_FAMILIES.spreadsheet.summary(
  {
    outcome: "working",
    message: "Draft updated.",
    workingFileId: "s1",
    formulaErrors: { count: 2 },
  },
  false,
);
const deck = OFFICE_FAMILIES.presentation.summary(
  { outcome: "working", message: "Draft updated.", workingFileId: "p1", renderedSlideIds: [1] },
  false,
);
const officeFailure = (family: "word" | "spreadsheet" | "presentation") =>
  OFFICE_FAMILIES[family].summary({ message: "The file is locked." }, true);

const outcomeCases = (
  family: "agent-draft" | "schedule-draft" | "document" | "project-file",
  name: string,
  ok: Body,
  failed: Body,
  code: string,
): Case[] => [
  { family, label: "landed", name, status: "complete", result: ok, start: {}, events: [ok] },
  {
    family,
    label: "refused with a reason",
    name,
    status: "error",
    result: failed,
    error: { code, message: "It changed meanwhile." },
    start: {},
    events: [{ ...failed, reason: "It changed meanwhile." }],
  },
];

const officeCases = (
  family: "word" | "spreadsheet" | "presentation",
  name: string,
  ok: Body,
): Case[] => [
  { family, label: "edited", name, status: "complete", result: ok, start: {}, events: [ok] },
  {
    family,
    label: "failed",
    name,
    status: "error",
    result: officeFailure(family),
    error: { code: "Failed", message: "The file is locked." },
    start: {},
    events: [officeFailure(family)],
  },
];

const CASES: Case[] = [
  ...outcomeCases(
    "agent-draft",
    "update_agent_draft",
    { outcome: "updated", draftId: "d1", revision: 2 },
    { outcome: "conflict", draftId: "d1" },
    "AgentDraftNotUpdated",
  ),
  ...outcomeCases(
    "schedule-draft",
    "update_schedule_draft",
    { outcome: "updated", draftId: "d1", revision: 3 },
    { outcome: "conflict" },
    "ScheduleDraftNotUpdated",
  ),
  ...outcomeCases(
    "document",
    "edit_document",
    { outcome: "updated", documentId: "doc-1", title: "Plan", revision: 4 },
    { outcome: "no_match", documentId: "doc-1" },
    "DocumentNotUpdated",
  ),
  ...outcomeCases(
    "project-file",
    "save_project_file",
    { outcome: "saved", fileId: "f1", fileName: "a.pptx", version: 2 },
    { outcome: "unavailable" },
    "ProjectFileNotUsed",
  ),
  ...officeCases("word", "edit_word_file", word),
  ...officeCases("spreadsheet", "edit_spreadsheet", sheet),
  ...officeCases("presentation", "edit_presentation", deck),
  {
    family: "skill",
    label: "read",
    name: "read_skill_file",
    status: "complete",
    result: skillActivity,
    start: { skillId: "s1", skillName: "Brand", path: "colors.md" },
    events: [skillActivity],
  },
  {
    family: "skill",
    label: "failed with its own error",
    name: "read_skill_file",
    status: "error",
    result: { ...skillActivity, status: "error", error: "No such file." },
    start: { skillId: "s1", skillName: "Brand", path: "colors.md" },
    events: [{ ...skillActivity, status: "error", error: "No such file." }],
  },
  {
    family: "knowledge",
    label: "searched inside a research task",
    name: "search_knowledge",
    status: "complete",
    result: { family: "knowledge", ok: true, summary: knowledgeSummary, sources: [] },
    start: { targets: ["refunds"] },
    events: [{ family: "knowledge", ok: true, summary: knowledgeSummary, sources: [] }],
    lineage: { runId: "run-9", taskId: "task-1" },
  },
  {
    family: "knowledge",
    label: "failed without words of its own",
    name: "search_knowledge",
    status: "error",
    result: { family: "knowledge", ok: false, summary: knowledgeSummary, sources: [] },
    error: { code: "ToolFailed", message: "knowledge tool failed" },
    start: { targets: ["refunds"] },
    events: [{ family: "knowledge", ok: false, summary: knowledgeSummary, sources: [] }],
  },
  {
    family: "tool-file",
    label: "published",
    name: "publish_file",
    status: "complete",
    result: { ok: true, ref: "working:w1@2", workingFileId: "w1", attachmentId: "att-1" },
    start: {},
    events: [{ ok: true, ref: "working:w1@2", workingFileId: "w1", attachmentId: "att-1" }],
  },
  {
    family: "tool-file",
    label: "not published",
    name: "create_file",
    status: "error",
    result: { ok: false, error: "Publication failed." },
    error: { code: "PublicationFailed", message: "Publication failed." },
    start: {},
    events: [{ ok: false, error: "Publication failed." }],
  },
  {
    family: "image",
    label: "drew",
    name: "generate_image",
    status: "complete",
    result: imageActivity({ ...image, attachmentIds: ["a1", "a2"], quality: "high" }),
    running: runningImageActivity(image),
    start: { model: image.model, editing: false, aspectRatio: "1:1", count: 2 },
    events: [imageActivity({ ...image, attachmentIds: ["a1", "a2"], quality: "high" })],
  },
  {
    family: "image",
    label: "drew nothing and said nothing",
    name: "generate_image",
    status: "error",
    result: imageActivity({ ...image, attachmentIds: [] }),
    error: { code: "ImageFailed", message: "No image was made." },
    running: runningImageActivity(image),
    start: { model: image.model, editing: false, aspectRatio: "1:1", count: 2 },
    events: [imageActivity({ ...image, attachmentIds: [] })],
  },
  {
    family: "image",
    label: "was refused",
    name: "generate_image",
    status: "error",
    result: imageActivity({ ...image, attachmentIds: [], refusal: "Not that." }),
    error: { code: "ImageRefused", message: "Not that." },
    running: runningImageActivity(image),
    start: { model: image.model, editing: false, aspectRatio: "1:1", count: 2 },
    events: [imageActivity({ ...image, attachmentIds: [], refusal: "Not that." })],
  },
  {
    family: "custom",
    label: "succeeded",
    name: "custom_math__add",
    status: "complete",
    result: customActivity,
    start: { displayName: "Add" },
    events: [
      {
        displayName: "Add",
        status: "complete",
        resultPreview: "3",
        resultChars: 1,
      },
    ],
  },
  {
    family: "custom",
    label: "threw",
    name: "custom_math__add",
    status: "error",
    result: {
      family: "custom",
      version: 1,
      name: "custom_math__add",
      displayName: "Add",
      status: "error",
      error: "Boom",
    },
    error: { code: "CustomToolFailed", message: "Boom" },
    start: { displayName: "Add" },
    events: [{ displayName: "Add", status: "error", error: "Boom" }],
  },
  {
    family: "integration",
    label: "wrote",
    name: "int_jira__create_issue",
    status: "complete",
    result: integrationActivity,
    start: {
      integrationId: "jira",
      tool: "create_issue",
      label: "Create issue",
      access: "write",
      summary: "Bug",
    },
    events: [{ activity: integrationActivity }],
  },
  {
    family: "integration",
    label: "was refused",
    name: "int_jira__create_issue",
    status: "error",
    result: refusedIntegration,
    error: { code: "IntegrationRefused", message: "Declined." },
    start: {
      integrationId: "jira",
      tool: "create_issue",
      label: "Create issue",
      access: "write",
      summary: "Bug",
    },
    events: [{ activity: refusedIntegration }],
  },
  {
    family: "desktop",
    label: "read a file",
    name: "read_local_file",
    status: "complete",
    result: desktopResult,
    arguments: { path: "a.ts" },
    start: { args: { path: "a.ts" } },
    events: [{ result: desktopResult }],
  },
  {
    family: "desktop",
    label: "was denied",
    name: "read_local_file",
    status: "error",
    result: { ...desktopResult, ok: false, summary: "Denied" },
    error: { code: "DesktopToolFailed", message: "Denied" },
    arguments: { path: "a.ts" },
    start: { args: { path: "a.ts" } },
    events: [{ result: { ...desktopResult, ok: false, summary: "Denied" } }],
  },
  {
    family: "research",
    label: "found evidence",
    name: "deep_research",
    status: "complete",
    result: { progress: progress("complete"), sources: [source] },
    running: { progress: progress("researching") },
    start: { runId: "run-1", progress: progress("researching") },
    events: [
      {
        ...researchPlacement,
        phase: "progress",
        progress: progress("researching"),
        sources: [source],
      },
      { ...researchPlacement, phase: "result", progress: progress("complete"), ok: true },
    ],
  },
  {
    family: "research",
    label: "finished without evidence",
    name: "deep_research",
    status: "error",
    result: { progress: progress("complete") },
    error: { code: "ResearchIncomplete", message: "Research produced no evidence." },
    running: { progress: progress("researching") },
    start: { runId: "run-1", progress: progress("researching") },
    events: [
      {
        ...researchPlacement,
        phase: "result",
        progress: progress("complete"),
        ok: false,
        error: "Research produced no evidence.",
      },
    ],
  },
  {
    family: "ask",
    label: "presented",
    name: "ask_user",
    status: "complete",
    result: { v: 1, outcome: "presented", questions },
    start: {},
    events: [{ result: { v: 1, outcome: "presented", questions } }],
  },
  {
    family: "ask",
    label: "rejected",
    name: "ask_user",
    status: "error",
    result: { v: 1, outcome: "rejected", message: "Too many questions." },
    error: { code: "QuestionRejected", message: "Too many questions." },
    start: {},
    events: [{ result: { v: 1, outcome: "rejected", message: "Too many questions." } }],
  },
  {
    family: "map",
    label: "routed",
    name: "map_route",
    status: "complete",
    result: route,
    start: {},
    events: [
      {
        ok: true,
        route: { mode: "walk", stops: ["A", "B"], distance: 1200, duration: 900 },
      },
    ],
  },
  {
    family: "map",
    label: "found no route",
    name: "map_route",
    status: "error",
    result: { v: 1, outcome: "rejected", message: "No route was found." },
    error: { code: "RouteNotFound", message: "No route was found." },
    start: {},
    events: [{ ok: false, error: "No route was found." }],
  },
  {
    family: "notify",
    label: "queued",
    name: "notify_user",
    status: "complete",
    result: { v: 1, outcome: "queued", message: "Prices dropped." },
    start: {},
    events: [{ ok: true, message: "Prices dropped." }],
  },
  {
    family: "notify",
    label: "sent nothing",
    name: "notify_user",
    status: "error",
    result: { v: 1, outcome: "rejected", message: "Nothing was sent." },
    error: { code: "NotifyRejected", message: "Nothing was sent." },
    start: {},
    events: [{ ok: false, error: "Nothing was sent." }],
  },
  {
    family: "plan",
    label: "updated",
    name: "update_plan",
    status: "complete",
    result: { v: 1, outcome: "updated", steps: [{ step: "Read", status: "in_progress" }] },
    start: {},
    events: [{ ok: true, steps: [{ step: "Read", status: "in_progress" }] }],
  },
  {
    family: "plan",
    label: "rejected",
    name: "update_plan",
    status: "error",
    result: { v: 1, outcome: "rejected", message: "Too many steps." },
    error: { code: "PlanRejected", message: "Too many steps." },
    start: {},
    events: [{ ok: false, error: "Too many steps." }],
  },
  {
    family: "attachment",
    label: "read a range",
    name: "read_attachment",
    status: "complete",
    result: { ok: true, fileName: "a.txt", mode: "range", from: 0, to: 10, total: 20 },
    start: {},
    events: [{ ok: true, fileName: "a.txt", mode: "range", from: 0, to: 10, total: 20 }],
  },
  {
    family: "attachment",
    label: "could not read",
    name: "read_attachment",
    status: "error",
    result: { ok: false, error: "The file could not be read." },
    error: { code: "AttachmentReadFailed", message: "The file could not be read." },
    start: {},
    events: [{ ok: false, error: "The file could not be read." }],
  },
  {
    family: "history",
    label: "read a page",
    name: "read_history",
    status: "complete",
    result: { ok: true, from: 1, to: 6, total: 40 },
    start: {},
    events: [{ ok: true, from: 1, to: 6, total: 40 }],
  },
  {
    family: "history",
    label: "refused a chat",
    name: "read_chat",
    status: "error",
    result: { ok: false, error: "No chat with that id can be read from here." },
    error: { code: "HistoryReadFailed", message: "No chat with that id can be read from here." },
    start: {},
    events: [{ ok: false, error: "No chat with that id can be read from here." }],
  },
  {
    family: "tool-load",
    label: "loaded",
    name: "load_tools",
    status: "complete",
    result: { loaded: ["word"], unavailable: [] },
    start: {},
    events: [{ ok: true, loaded: ["word"] }],
  },
  {
    family: "tool-load",
    label: "failed",
    name: "load_tools",
    status: "error",
    result: null,
    error: { code: "ToolLoadFailed", message: "The tools could not be loaded." },
    start: {},
    events: [{ ok: false }],
  },
  {
    family: "memory",
    label: "saved to the project",
    name: "save_memory",
    status: "complete",
    result: { outcome: "created", scope: "project" },
    start: {},
    events: [{ ok: true, outcome: "created", scope: "project" }],
  },
  {
    family: "memory",
    label: "refused",
    name: "save_memory",
    status: "error",
    result: { outcome: "rejected", reason: "sensitive" },
    error: { code: "MemoryNotSaved", message: "memory was not saved" },
    start: {},
    events: [
      { ok: false, outcome: "rejected", reason: "sensitive", error: "memory was not saved" },
    ],
  },
  {
    family: "web",
    label: "searched inside a research task",
    name: "web_search",
    status: "complete",
    result: { targets: ["effect"], resultCount: 2, pagesFetched: 1, sources: [source] },
    arguments: { queries: ["effect"] },
    start: { args: { targets: ["effect"] } },
    events: [
      {
        phase: "progress",
        summary: { targets: ["effect"], resultCount: 2 },
        pages: [{ url: source.url, status: "reading" }],
      },
      {
        ok: true,
        summary: { targets: ["effect"], resultCount: 2, pagesFetched: 1 },
        sources: [source],
      },
    ],
    lineage: { runId: "run-9", taskId: "task-1" },
  },
  {
    family: "web",
    label: "failed",
    name: "read_url",
    status: "error",
    result: { targets: ["https://example.com"] },
    error: { code: "ToolFailed", message: "blocked" },
    arguments: { urls: ["https://example.com"] },
    start: { args: { targets: ["https://example.com"] } },
    events: [{ ok: false, summary: { targets: ["https://example.com"] }, error: "blocked" }],
  },
];

/** Families whose start names what their running row does not keep. */
const NAMED_ONLY_LIVE = new Set<Family>(["custom", "integration", "skill", "knowledge"]);

const placement = { turnIndex: 1, callIndex: 2, textOffset: 5 };

const envelope = (testCase: Case, body: Body) => {
  const value = {
    v: 1,
    family: testCase.family,
    callId: "call-1",
    name: testCase.name,
    ...testCase.lineage,
    phase: "result",
    ...body,
  };
  // The fixture must be an envelope the server is allowed to send.
  Schema.decodeUnknownSync(ToolChunkEnvelope)(value);
  return JSON.stringify(value);
};

const live = (testCase: Case, through = testCase.events.length) =>
  [
    { ...placement, ...testCase.start, phase: "start" },
    ...testCase.events.slice(0, through),
  ].reduce<ToolActivity[]>((tools, body) => applyToolChunk(tools, envelope(testCase, body)), []);

const stored = (testCase: Case, running = false) =>
  toActivity({
    id: "call-1",
    toolName: testCase.name,
    family: testCase.family,
    arguments: testCase.arguments ?? {},
    result: running ? (testCase.running ?? null) : testCase.result,
    status: running ? "running" : testCase.status,
    error: running ? null : (testCase.error ?? null),
    researchRunId: testCase.lineage?.runId ?? null,
    researchTaskId: testCase.lineage?.taskId ?? null,
    ...placement,
  });

describe("tool families", () => {
  it("has a settled and a failed call for every family", () => {
    for (const family of Object.keys(TOOL_FAMILIES)) {
      const statuses = new Set(CASES.filter((c) => c.family === family).map((c) => c.status));
      expect([family, ...statuses]).toEqual([family, "complete", "error"]);
    }
  });

  it.each(CASES.map((testCase) => [`${testCase.family} ${testCase.label}`, testCase] as const))(
    "%s: the stream and a reload agree",
    (_label, testCase) => {
      const activity = stored(testCase);
      expect(activity.family).toBe(testCase.family);
      expect(activity.status).toBe(testCase.status);
      expect(live(testCase)).toEqual([activity]);
    },
  );

  it.each(
    CASES.filter((testCase) => !NAMED_ONLY_LIVE.has(testCase.family)).map(
      (testCase) => [`${testCase.family} ${testCase.label}`, testCase] as const,
    ),
  )("%s: a running row reloads as the stream started it", (_label, testCase) => {
    expect(live(testCase, 0)).toEqual([stored(testCase, true)]);
  });

  it("keeps a spreadsheet's formula errors when its summary is read back", () => {
    const sheetCase = CASES.find((testCase) => testCase.family === "spreadsheet")!;
    expect(stored(sheetCase)).toMatchObject({ formulaErrors: 2 });
  });
});
