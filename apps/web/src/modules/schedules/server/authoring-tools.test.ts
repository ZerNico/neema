import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  EMPTY_SCHEDULE_DRAFT,
  type PatchScheduleDraftInput,
  type ScheduleDraft,
} from "../draft-schema.ts";
import { prepareScheduleDraftTools, type ScheduleAuthoringServices } from "./authoring-tools.ts";

const unexpected = () => Effect.die(new Error("Unexpected service call"));
const writeGuard = () => Effect.void;

async function setup() {
  let draft: ScheduleDraft = {
    id: "draft-one",
    conversationId: "authoring-chat",
    kind: "schedule",
    settings: {
      ...EMPTY_SCHEDULE_DRAFT,
      name: "Daily reminder",
      chatMode: "same",
      chatId: "target-chat",
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
  const services: ScheduleAuthoringServices = {
    drafts: {
      list: () => Effect.succeed([draft]),
      patch,
      get: unexpected,
      open: unexpected,
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
      isModelAccessible: unexpected,
      updateModelAccess: unexpected,
      listModelAccess: unexpected,
      getModel: unexpected,
      createModel: unexpected,
      updateModel: unexpected,
      setModelFormat: unexpected,
      deleteModel: unexpected,
    },
  };
  const prepared = await Effect.runPromise(
    prepareScheduleDraftTools({
      services,
      userId: "user-one",
      conversationId: draft.conversationId,
      messageId: "answer-one",
      writeGuard,
    }),
  );
  const update = prepared.group.handlers.update_schedule_draft as (
    raw: unknown,
  ) => Effect.Effect<unknown>;
  return { update, patch };
}

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
