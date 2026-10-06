import { describe, expect, it } from "vitest";
import { normalizeGrant, undeclaredAllowance } from "./validate.ts";

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
