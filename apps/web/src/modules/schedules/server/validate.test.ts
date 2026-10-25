import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { EMPTY_SCHEDULE_DRAFT } from "../draft-schema.ts";
import { normalizeGrant, undeclaredAllowance, validateScheduleSettings } from "./validate.ts";

describe("schedule integration grants", () => {
  it("stores allowance addresses as the mailbox parser writes them", () => {
    expect(
      normalizeGrant({
        connectionId: "connection",
        integrationId: "outlook",
        access: "write",
        allowances: { send: { targets: ["Ana@Example.com", "ana@example.com", "bo@bücher.de"] } },
      }),
    ).toEqual({
      connectionId: "connection",
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
    expect(
      normalizeGrant({ connectionId: "connection", integrationId: "outlook", ...grant }),
    ).toMatch(reason);
  });

  it("finds an allowance the integration's type does not declare", () => {
    const grant = {
      connectionId: "connection",
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
  // Which models are usable is the providers' one query; this checks the
  // schedule asks it about a chat model and refuses what it does not return.
  const validate = (usable: boolean) => {
    const asked: string[] = [];
    return Effect.runPromise(
      Effect.result(
        validateScheduleSettings(
          {
            providers: {
              usableModel: (_userId: string, modelId: string, type: string) => {
                asked.push(`${modelId}:${type}`);
                return Effect.succeed(usable ? { id: modelId } : null);
              },
            } as never,
            agents: {} as never,
            policy: { can: () => Effect.succeed(true) } as never,
          },
          "user-1",
          settings,
        ),
      ),
    ).then((result) => ({ result, asked }));
  };

  it("refuses a model a send could not use", async () => {
    const { result, asked } = await validate(false);
    expect(asked).toEqual(["m1:chat"]);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { reason: "selected model is unavailable" },
    });
  });

  it("accepts a usable chat model", async () => {
    expect((await validate(true)).result).toMatchObject({ _tag: "Success" });
  });
});
