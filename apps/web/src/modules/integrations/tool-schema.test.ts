import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { integrationActivityFromRow } from "~/modules/chat/client/tool-families.ts";
import { IntegrationToolActivity, projectIntegrationToolResult } from "./tool-schema.ts";

const base = {
  name: "int_outline__create_document",
  integrationId: "outline",
  tool: "create_document",
  label: "Create an Outline document",
  access: "write" as const,
  summary: "“Plan”",
  sources: [],
};

describe("integration row projection", () => {
  it("keeps the page a write produced, never the arguments or body", () => {
    const activity = projectIntegrationToolResult({
      ...base,
      raw: {
        ok: true,
        result: {
          id: "d1",
          title: "Plan",
          url: "https://docs.example.com/doc/plan",
          text: "secret",
        },
        link: { title: "Plan", url: "https://docs.example.com/doc/plan" },
      },
      isFailure: false,
    });
    expect(activity).toMatchObject({
      status: "complete",
      link: { title: "Plan", url: "https://docs.example.com/doc/plan" },
    });
    expect(JSON.stringify(activity)).not.toContain("secret");
    expect(Schema.is(IntegrationToolActivity)(activity)).toBe(true);
  });

  it("names the connected app a decision was made in, on the row and its reload projection", () => {
    const activity = projectIntegrationToolResult({
      ...base,
      raw: { ok: false, refused: true, error: "The user declined this action." },
      isFailure: false,
      decided: { decision: "deny", app: "Claude" },
    });
    expect(activity.decidedIn).toEqual({ decision: "deny", app: "Claude" });
    expect(Schema.is(IntegrationToolActivity)(activity)).toBe(true);
    expect(integrationActivityFromRow("row-1", activity).decidedIn).toEqual({
      decision: "deny",
      app: "Claude",
    });
  });

  it("tells a refusal apart from a failure", () => {
    expect(
      projectIntegrationToolResult({
        ...base,
        raw: { ok: false, refused: true, error: "The user declined this action." },
        isFailure: false,
      }),
    ).toMatchObject({ status: "refused", error: "The user declined this action." });
    expect(
      projectIntegrationToolResult({
        ...base,
        raw: { ok: false, error: "Outline: boom" },
        isFailure: false,
      }),
    ).toMatchObject({ status: "error", error: "Outline: boom" });
  });

  it("links only what the adapter named, never a guess from the output's shape", () => {
    const activity = projectIntegrationToolResult({
      ...base,
      raw: { ok: true, result: { title: "Plan", url: "https://docs.example.com/doc/plan" } },
      isFailure: false,
    });
    expect(activity.link).toBeUndefined();
    expect(
      projectIntegrationToolResult({
        ...base,
        raw: { ok: true, result: {}, link: { title: "Plan", url: "javascript:alert(1)" } },
        isFailure: false,
      }).link,
    ).toBeUndefined();
  });
});
