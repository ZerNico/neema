import { describe, expect, it } from "vitest";
import { normalizeGrant } from "./validate.ts";

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
      { access: "write" as const, allowances: { forward: { targets: ["ana@example.com"] } } },
      /unknown/,
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
      /add an address for “Invite people”/,
    ],
  ])("refuses %j", (grant, reason) => {
    expect(normalizeGrant({ integrationId: "outlook", ...grant })).toMatch(reason);
  });

  it("refuses an allowance an integration does not declare", () => {
    expect(
      normalizeGrant({
        integrationId: "outline",
        access: "write",
        allowances: { send: { targets: ["ana@example.com"] } },
      }),
    ).toMatch(/unknown/);
  });
});
