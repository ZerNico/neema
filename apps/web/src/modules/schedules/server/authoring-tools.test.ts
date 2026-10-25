import { Effect, Stream } from "effect";
import { type AiError, type Tool } from "effect/ai";
import { describe, expect, it, vi } from "vitest";
import { mergeToolGroups } from "~/modules/tools/server/toolset.ts";
import {
  EMPTY_SCHEDULE_DRAFT,
  type PatchScheduleDraftInput,
  type ScheduleDraft,
} from "../draft-schema.ts";
import { prepareScheduleDraftTools, type ScheduleAuthoringServices } from "./authoring-tools.ts";

const unexpected = () => Effect.die(new Error("Unexpected service call"));
const writeGuard = () => Effect.void;

async function setup(timeZone?: string, settings: Partial<ScheduleDraft["settings"]> = {}) {
  let draft: ScheduleDraft = {
    id: "draft-one",
    conversationId: "authoring-chat",
    kind: "schedule",
    settings: {
      ...EMPTY_SCHEDULE_DRAFT,
      name: "Daily reminder",
      chatMode: "same",
      chatId: "target-chat",
      ...settings,
    },
    revision: 1,
    targetId: "schedule-one",
    targetRevision: null,
    savedDraftRevision: 1,
    createdAt: "2026-09-26T00:00:00.000Z",
    updatedAt: "2026-09-26T00:00:00.000Z",
  };
  const patch = vi.fn((_userId: string, input: PatchScheduleDraftInput) =>
    Effect.sync(() => {
      draft = {
        ...draft,
        settings: { ...draft.settings, ...input.changes },
        revision: draft.revision + 1,
      };
      return { outcome: "updated" as const, draft };
    }),
  );
  const open = vi.fn(() => Effect.succeed({ outcome: "drafted" as const, draft }));
  const services: ScheduleAuthoringServices = {
    drafts: {
      list: () => Effect.succeed([draft]),
      patch,
      get: unexpected,
      open,
      save: unexpected,
      reload: unexpected,
      discard: unexpected,
    },
    providers: {
      listChatModelsFor: () => Effect.succeed([]),
      listImageModelsFor: () => Effect.succeed([]),
      listProviders: unexpected,
      createProvider: unexpected,
      updateProvider: unexpected,
      deleteProvider: unexpected,
      getProviderWithKey: unexpected,
      listModels: unexpected,
      setDefaultModelOrder: unexpected,
      getUtilityModelId: unexpected,
      setUtilityModelId: unexpected,
      usableModel: unexpected,
      updateModelAccess: unexpected,
      listModelAccess: unexpected,
      getModel: unexpected,
      createModel: unexpected,
      updateModel: unexpected,
      setModelFormat: unexpected,
      deleteModel: unexpected,
    },
    // Only what the options tool reads; anything else would be a surprise here.
    agents: {
      list: () =>
        Effect.succeed([
          { id: "agent-own", name: "Researcher", description: "Mine", canEdit: true },
          { id: "agent-shared", name: "Shared", description: "Not mine", canEdit: false },
        ]),
    } as never,
    skills: { list: unexpected } as never,
    knowledge: { listCollections: unexpected } as never,
  };
  const prepared = await Effect.runPromise(
    prepareScheduleDraftTools({
      services,
      userId: "user-one",
      conversationId: draft.conversationId,
      messageId: "answer-one",
      timeZone,
      writeGuard,
    }),
  );
  const update = prepared.group.handlers.update_schedule_draft as (
    raw: unknown,
  ) => Effect.Effect<unknown>;
  const draftSchedule = prepared.group.handlers.draft_schedule as (
    raw: unknown,
  ) => Effect.Effect<unknown>;
  // Through the merged toolkit, so every result is encoded as a provider would get it.
  const call = (name: string, params: unknown) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const toolkit = (yield* mergeToolGroups([prepared.group]))!;
        // An untyped toolkit reports unknown services; its handlers' were provided when merged.
        const stream = yield* toolkit.handle(name as never, params as never) as Effect.Effect<
          Stream.Stream<Tool.HandlerResult<Tool.Any>, AiError.AiError, never>,
          AiError.AiError,
          never
        >;
        return [...(yield* Stream.runCollect(stream))].at(-1)!.result;
      }),
    );
  return { update, patch, open, draftSchedule, call };
}

describe("an unfinished schedule draft", () => {
  it("reads back with blank text, as the person left it", async () => {
    const { call } = await setup(undefined, { name: "", cron: "", prompt: "" });
    expect(await call("read_schedule_draft", { draftId: "draft-one" })).toMatchObject({
      outcome: "read",
      draft: { settings: { name: "", cron: "", prompt: "" } },
    });
  });
});

describe("list_schedule_options", () => {
  it("lists only the person's own agents, since a schedule runs only those", async () => {
    const { call } = await setup();
    expect(await call("list_schedule_options", { kind: "agent" })).toEqual({
      outcome: "options",
      options: [{ id: "agent-own", name: "Researcher", description: "Mine" }],
    });
  });
});

describe("schedule draft id aliases", () => {
  it.each(["draft_id", "draft", "id"])("reads a top-level %s as the draftId", async (key) => {
    const { update, patch } = await setup();
    await Effect.runPromise(
      update({ [key]: "draft-one", expectedRevision: 1, changes: { name: "Renamed" } }),
    );
    expect(patch).toHaveBeenCalledExactlyOnceWith(
      "user-one",
      { draftId: "draft-one", expectedRevision: 1, changes: { name: "Renamed" } },
      writeGuard,
    );
  });
});

describe("schedule draft authority", () => {
  it("refuses integration grants from the model and leaves the draft alone", async () => {
    const { update, patch } = await setup();
    const result = await Effect.runPromise(
      update({
        draftId: "draft-one",
        expectedRevision: 1,
        changes: {
          integrationGrants: [
            {
              integrationId: "mail",
              access: "write",
              allowances: { send: { targets: ["attacker@example.com"] } },
            },
          ],
        },
      }),
    );

    expect(patch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outcome: "invalid" });
  });
});

describe("schedule draft chat target normalization", () => {
  it.each(["chatId", "chat_id", "conversationId", "conversation_id"])(
    "clears a populated chat target when %s is null",
    async (key) => {
      const { update, patch } = await setup();
      const result = await Effect.runPromise(
        update({ draftId: "draft-one", expectedRevision: 1, changes: { [key]: null } }),
      );

      expect(patch).toHaveBeenCalledExactlyOnceWith(
        "user-one",
        { draftId: "draft-one", expectedRevision: 1, changes: { chatId: null } },
        writeGuard,
      );
      expect(result).toMatchObject({
        outcome: "updated",
        changedFields: ["chatId"],
        draft: {
          revision: 2,
          settings: { name: "Daily reminder", chatMode: "same", chatId: null },
        },
      });
    },
  );

  it("preserves the populated chat target when chatId is omitted", async () => {
    const { update, patch } = await setup();
    const result = await Effect.runPromise(
      update({
        draftId: "draft-one",
        expectedRevision: 1,
        changes: { name: "Renamed reminder" },
      }),
    );

    expect(patch).toHaveBeenCalledExactlyOnceWith(
      "user-one",
      { draftId: "draft-one", expectedRevision: 1, changes: { name: "Renamed reminder" } },
      writeGuard,
    );
    expect(result).toMatchObject({
      outcome: "updated",
      changedFields: ["name"],
      draft: {
        revision: 2,
        settings: { name: "Renamed reminder", chatMode: "same", chatId: "target-chat" },
      },
    });
  });
});

describe("schedule draft image model", () => {
  it.each(["imageModelId", "imageModel", "image_model", "image_model_id"])(
    "sets the image model a fire draws with through %s",
    async (key) => {
      const { update, patch } = await setup();
      const result = await Effect.runPromise(
        update({ draftId: "draft-one", expectedRevision: 1, changes: { [key]: "image-model" } }),
      );
      expect(patch).toHaveBeenCalledExactlyOnceWith(
        "user-one",
        { draftId: "draft-one", expectedRevision: 1, changes: { imageModelId: "image-model" } },
        writeGuard,
      );
      expect(result).toMatchObject({ outcome: "updated", changedFields: ["imageModelId"] });
    },
  );

  it("clears it with null, leaving the choice to each chat", async () => {
    const { update, patch } = await setup();
    await Effect.runPromise(
      update({ draftId: "draft-one", expectedRevision: 1, changes: { imageModel: null } }),
    );
    expect(patch).toHaveBeenCalledExactlyOnceWith(
      "user-one",
      { draftId: "draft-one", expectedRevision: 1, changes: { imageModelId: null } },
      writeGuard,
    );
  });
});

describe("a new schedule draft's time zone", () => {
  const openedWith = (open: { mock: { calls: unknown[][] } }) => {
    const input = open.mock.calls[0]?.[1];
    return input && typeof input === "object" && "changes" in input
      ? (input.changes as { timezone?: string } | undefined)?.timezone
      : undefined;
  };

  it("is the person's unless the model names one", async () => {
    const own = await setup("Europe/Berlin");
    await Effect.runPromise(own.draftSchedule({ changes: { name: "Standup" } }));
    expect(openedWith(own.open)).toBe("Europe/Berlin");
    const named = await setup("Europe/Berlin");
    await Effect.runPromise(named.draftSchedule({ changes: { timezone: "Asia/Tokyo" } }));
    expect(openedWith(named.open)).toBe("Asia/Tokyo");
  });

  it("is left to the saved schedule when the draft edits one", async () => {
    const existing = await setup("Europe/Berlin");
    await Effect.runPromise(existing.draftSchedule({ scheduleId: "schedule-one" }));
    expect(openedWith(existing.open)).toBeUndefined();
  });
});
