import { describe, expect, it } from "vitest";
import { accountUsability } from "./credentials.ts";
import type { IntegrationConfigRow } from "./repo.ts";

const outline = (changes: Partial<IntegrationConfigRow> = {}): IntegrationConfigRow => ({
  id: "outline",
  kind: "outline",
  name: "Outline",
  description: null,
  ownerUserId: null,
  draft: false,
  enabled: true,
  config: { baseUrl: "https://docs.example.com/" },
  oauthClientId: null,
  oauthClientSecretCiphertext: null,
  oauthClientIssuer: null,
  fingerprint: "https://docs.example.com",
  revision: 1,
  allowApiKeys: true,
  toolSettings: {},
  sharedCredentialCiphertext: null,
  audience: "instance",
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...changes,
});

const account = {
  status: "active" as const,
  configFingerprint: "https://docs.example.com",
  authKind: "api_key" as const,
};

const verdict = (state: ReturnType<typeof accountUsability>) =>
  state.usable ? "usable" : state.reason;

describe("whether an account works now", () => {
  it("works while its integration may be used and it signed in to this server", () => {
    expect(verdict(accountUsability(outline(), true, account))).toBe("usable");
  });

  it("is unavailable when its integration is off, unshared or unconfigured", () => {
    expect(verdict(accountUsability(outline({ enabled: false }), true, account))).toBe(
      "unavailable",
    );
    expect(verdict(accountUsability(outline(), false, account))).toBe("unavailable");
    expect(verdict(accountUsability(outline({ config: {} }), true, account))).toBe("unavailable");
    expect(verdict(accountUsability(outline({ kind: "gone" }), true, account))).toBe("unavailable");
  });

  it("needs signing in again when refused, moved, or its way in closed", () => {
    expect(verdict(accountUsability(outline(), true, { ...account, status: "needs_reauth" }))).toBe(
      "needs_reauth",
    );
    expect(
      verdict(
        accountUsability(outline(), true, {
          ...account,
          configFingerprint: "https://old.example.com",
        }),
      ),
    ).toBe("needs_reauth");
    const mcp = outline({
      kind: "mcp",
      config: { url: "https://mcp.example.com/", ways: "oauth" },
    });
    const token = {
      status: "active" as const,
      configFingerprint: "https://mcp.example.com/ ",
      authKind: "api_key" as const,
    };
    expect(verdict(accountUsability(mcp, true, { ...token, authKind: "oauth" }))).toBe("usable");
    expect(verdict(accountUsability(mcp, true, token))).toBe("needs_reauth");
  });
});
