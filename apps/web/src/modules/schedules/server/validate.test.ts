import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { EMPTY_SCHEDULE_DRAFT } from "../draft-schema.ts";
import { normalizeGrant, undeclaredAllowance, validateScheduleSettings } from "./validate.ts";

describe("schedule integration grants", () => {
  it("stores allowance addresses as the mailbox parser writes them", () => {
    expect(
      normalizeGrant({
        integrationId: "outlook",
        access: "write",
        allowances: { send: { targets: ["Ana@Example.com", "ana@example.com", "bo@bücher.de"] } },
      }),
    ).toEqual({
      integrationId: "outlook",
      access: "write",
      allowances: { send: { targets: ["ana@example.com", "bo@xn--bcher-kva.de"] } },
    });
  });

  it.each([
    [
      { access: "read" as const, allowances: { send: { targets: ["ana@example.com"] } } },
      /read-and-write/,
    ],
    [
      { access: "write" as const, allowances: { send: { targets: ["Ana <ana@example.com>"] } } },
      /not a plain email/,
    ],
    [
      { access: "write" as const, allowances: { send: { targets: ["*@example.com"] } } },
      /not a plain email/,
    ],
    [
      { access: "write" as const, allowances: { invite: { targets: [] } } },
      /add at least one address/,
    ],
  ])("refuses %j", (grant, reason) => {
    expect(normalizeGrant({ integrationId: "outlook", ...grant })).toMatch(reason);
  });

  it("finds an allowance the integration's type does not declare", () => {
    const grant = {
      integrationId: "docs",
      access: "write" as const,
      allowances: { send: { targets: ["ana@example.com"] } },
    };
    // Checked by type, whatever the integration is called.
    expect(undeclaredAllowance(grant, "outline")).toBe("send");
    expect(undeclaredAllowance({ ...grant, integrationId: "mail-2" }, "outlook")).toBeNull();
  });
});

describe("schedule model", () => {
  const settings = {
    ...EMPTY_SCHEDULE_DRAFT,
    name: "Morning brief",
    scheduleText: "every morning",
    cron: "0 8 * * *",
    prompt: "Summarize the news",
    modelId: "m1",
  };
  const validate = (model: { type: "chat" | "image"; enabled: boolean }) =>
    Effect.runPromise(
      Effect.result(
        validateScheduleSettings(
          {
            // Only what the model check reads; the rest of the settings name nothing.
            providers: {
              getModel: () => Effect.succeed({ id: "m1", ...model }),
              isModelAccessible: () => Effect.succeed(true),
            } as never,
            agents: {} as never,
            policy: { can: () => Effect.succeed(true) } as never,
          },
          "user-1",
          settings,
        ),
      ),
    );

  it.each([
    { type: "image" as const, enabled: true },
    { type: "chat" as const, enabled: false },
  ])("refuses a model a send could not use: %j", async (model) => {
    expect(await validate(model)).toMatchObject({
      _tag: "Failure",
      failure: { reason: "selected model is unavailable" },
    });
  });

  it("accepts an enabled chat model", async () => {
    expect(await validate({ type: "chat", enabled: true })).toMatchObject({ _tag: "Success" });
  });
});
