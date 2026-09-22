import { Schema } from "effect";
import { Response } from "effect/unstable/ai";
import { describe, expect, it } from "vitest";
import {
  ScheduleDraftToolEnvelope,
  projectScheduleDraftResult,
  redactScheduleDraftPart,
  scheduleDraftFailureReason,
  scheduleDraftResultOk,
} from "./tool-schema.ts";

const privateResult = {
  outcome: "updated",
  revision: 3,
  changedFields: ["prompt"],
  draftId: "draft-1",
  draftConversationId: "conversation-1",
  draft: { settings: { prompt: "PRIVATE_PROMPT" } },
  error: "PRIVATE_DRIVER_ERROR",
};

describe("schedule authoring projections", () => {
  it("reconstructs only bounded activity metadata", () => {
    expect(projectScheduleDraftResult(privateResult)).toEqual({
      outcome: "updated",
      revision: 3,
      changedFields: ["prompt"],
      draftId: "draft-1",
      draftConversationId: "conversation-1",
    });
    for (const value of [
      null,
      "PRIVATE",
      { outcome: "saved" },
      { outcome: "updated", changedFields: ["PRIVATE"] },
    ])
      expect(projectScheduleDraftResult(value)).toEqual({ outcome: "invalid" });
    expect(scheduleDraftResultOk({ outcome: "conflict" })).toBe(false);
    expect(scheduleDraftResultOk({ outcome: "unchanged" })).toBe(true);
  });

  it("requires an explicit family and recognized tool", () => {
    const envelope = {
      v: 1,
      family: "schedule-draft",
      name: "update_schedule_draft",
      phase: "result",
      callId: "c",
      outcome: "updated",
    };
    expect(Schema.is(ScheduleDraftToolEnvelope)(envelope)).toBe(true);
    expect(Schema.is(ScheduleDraftToolEnvelope)({ ...envelope, family: "agent-draft" })).toBe(false);
    expect(Schema.is(ScheduleDraftToolEnvelope)({ ...envelope, name: "draft_agent" })).toBe(false);
  });

  it("keeps full drafts and malformed inputs out of continuation and compaction", () => {
    const call = Response.makePart("tool-call", {
      id: "c",
      name: "update_schedule_draft",
      params: { prompt: "PRIVATE_INPUT" },
      providerExecuted: false,
    });
    const result = Response.toolResultPart({
      id: "c",
      name: "update_schedule_draft",
      result: privateResult,
      encodedResult: privateResult,
      isFailure: false,
      providerExecuted: false,
      preliminary: false,
    });
    expect(redactScheduleDraftPart(call)).toMatchObject({ params: {} });
    const projected = redactScheduleDraftPart(result);
    expect(JSON.stringify(projected)).not.toContain("PRIVATE");
    expect(projected).toMatchObject({
      result: { outcome: "updated", draftId: "draft-1" },
      encodedResult: { outcome: "updated", draftId: "draft-1" },
    });
  });

  it("keeps a handler's own reason for a non-update and drops everything else", () => {
    expect(
      scheduleDraftFailureReason({
        outcome: "invalid",
        message: 'Expected string at ["cron"]',
      }),
    ).toBe('Expected string at ["cron"]');
    expect(scheduleDraftFailureReason({ outcome: "updated", message: "PRIVATE" })).toBeUndefined();
    expect(scheduleDraftFailureReason({ outcome: "invalid" })).toBeUndefined();
    expect(scheduleDraftFailureReason("PRIVATE")).toBeUndefined();
    expect(
      scheduleDraftFailureReason({ outcome: "unavailable", message: "y".repeat(1000) }),
    ).toHaveLength(600);
    expect(
      Schema.is(ScheduleDraftToolEnvelope)({
        v: 1,
        family: "schedule-draft",
        phase: "result",
        callId: "c",
        name: "draft_schedule",
        outcome: "invalid",
        reason: "why",
      }),
    ).toBe(true);
  });

  it("redacts a failure-shaped success row to the invalid outcome", () => {
    const failed = Response.toolResultPart({
      id: "c",
      name: "draft_schedule",
      result: privateResult,
      encodedResult: privateResult,
      isFailure: true,
      providerExecuted: false,
      preliminary: false,
    });
    const redacted = redactScheduleDraftPart(failed);
    expect(redacted).toMatchObject({
      result: { outcome: "invalid" },
      encodedResult: { outcome: "invalid" },
    });
    expect(JSON.stringify(redacted)).not.toContain("PRIVATE");
    expect(JSON.stringify(redacted)).not.toContain("conversation-1");
  });
});
