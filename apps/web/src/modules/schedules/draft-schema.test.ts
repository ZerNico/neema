import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { EMPTY_SCHEDULE_DRAFT, ScheduleDraftPatch, ScheduleDraftSettings } from "./draft-schema.ts";

describe("schedule draft settings", () => {
  it("accepts unfinished text and rejects missing or over-limit fields", () => {
    const draft = {
      ...EMPTY_SCHEDULE_DRAFT,
      name: "Standup summary",
      scheduleText: "every weekday at 7am",
      cron: "0 7 * * 1-5",
      timezone: "Europe/Berlin",
      prompt: "Summarize yesterday's threads.",
    };
    expect(Schema.decodeUnknownSync(ScheduleDraftSettings)(draft)).toEqual(draft);
    // A draft is working input: only Save requires the text to be there.
    expect(Schema.is(ScheduleDraftSettings)(EMPTY_SCHEDULE_DRAFT)).toBe(true);
    expect(Schema.is(ScheduleDraftSettings)({ ...draft, name: "", cron: "", prompt: "" })).toBe(
      true,
    );
    for (const input of [
      { ...draft, name: "x".repeat(201) },
      { ...draft, cron: "x".repeat(101) },
      { ...draft, prompt: "x".repeat(8001) },
      { ...draft, chatMode: undefined },
      { ...draft, integrationGrants: undefined },
      { ...draft, modelId: "" },
      { ...draft, skillIds: Array.from({ length: 21 }, (_, i) => String(i)) },
      { ...draft, collectionIds: Array.from({ length: 6 }, (_, i) => String(i)) },
      { ...draft, skillIds: undefined },
      { name: "Incomplete" },
    ])
      expect(Schema.is(ScheduleDraftSettings)(input)).toBe(false);
  });

  it("preserves omitted fields, accepts intentional clears, and rejects undefined values", () => {
    const decode = Schema.decodeUnknownSync(ScheduleDraftPatch);
    expect(decode({ scheduleText: "Still typing", collectionIds: [], endAt: null })).toEqual({
      scheduleText: "Still typing",
      collectionIds: [],
      endAt: null,
    });
    expect(decode({})).toEqual({});
    expect(decode({ modelId: null, agentId: null })).toEqual({ modelId: null, agentId: null });
    expect(Schema.is(ScheduleDraftPatch)({ name: undefined })).toBe(false);
    expect(Schema.is(ScheduleDraftPatch)({ searchEnabled: "true" })).toBe(false);
    expect(Schema.is(ScheduleDraftPatch)({ endAt: undefined })).toBe(false);
  });

  it("treats endAt as a nullable string the save step validates", () => {
    const draft = {
      ...EMPTY_SCHEDULE_DRAFT,
      name: "One shot",
      scheduleText: "tomorrow at 7am",
      cron: "0 7 22 9 *",
      prompt: "Remind me.",
    };
    expect(Schema.is(ScheduleDraftSettings)({ ...draft, endAt: null })).toBe(true);
    expect(Schema.is(ScheduleDraftSettings)({ ...draft, endAt: "2026-09-22T07:00:00.000Z" })).toBe(
      true,
    );
    expect(Schema.is(ScheduleDraftSettings)({ ...draft, endAt: 5 })).toBe(false);
  });
});
