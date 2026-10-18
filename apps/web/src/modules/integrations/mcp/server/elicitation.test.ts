import { describe, expect, it } from "vitest";
import { promptOf, resultOf, schemaOf } from "./elicitation.ts";

describe("elicitation prompts", () => {
  const form = promptOf({
    mode: "form",
    message: "Which project?",
    requestedSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          title: "Project",
          enum: ["web", "api"],
          enumNames: ["Web", "API"],
        },
        email: { type: "string", format: "email" },
        count: { type: "integer", minimum: 1, maximum: 5 },
        notify: { type: "boolean", default: true },
        labels: {
          type: "array",
          // A server may leave a title out; the value then stands for itself.
          items: { anyOf: [{ const: "bug", title: "Bug" }, { const: "ux" }] } as never,
        },
      },
      required: ["project", "count"],
    },
  });

  it("shows the spec's primitive fields as a form", () => {
    expect(form).toMatchObject({
      mode: "form",
      message: "Which project?",
      fields: [
        {
          key: "project",
          label: "Project",
          kind: "choice",
          required: true,
          options: [
            { value: "web", label: "Web" },
            { value: "api", label: "API" },
          ],
        },
        { key: "email", kind: "email", required: false },
        { key: "count", kind: "integer", min: 1, max: 5, required: true },
        { key: "notify", kind: "boolean", default: true },
        {
          key: "labels",
          kind: "choices",
          options: [
            { value: "bug", label: "Bug" },
            { value: "ux", label: "ux" },
          ],
        },
      ],
    });
  });

  it("writes a form back as the schema it was read from", () => {
    if (form?.mode !== "form") throw new Error("expected a form");
    const again = promptOf({
      mode: "form",
      message: form.message,
      requestedSchema: schemaOf(form.fields),
    });
    expect(again).toEqual(form);
  });

  it("declines what it cannot show faithfully", () => {
    expect(
      promptOf({
        mode: "form",
        message: "Nested",
        requestedSchema: { type: "object", properties: { address: { type: "object" } } } as never,
      }),
    ).toBeNull();
    expect(
      promptOf({
        mode: "url",
        message: "Go",
        url: "http://example.com/pay",
        elicitationId: "1",
      } as never),
    ).toBeNull();
    const wide = (count: number, key = (index: number) => `field${index}`) =>
      promptOf({
        mode: "form",
        message: "Many",
        requestedSchema: {
          type: "object",
          properties: Object.fromEntries(
            Array.from({ length: count }, (_, index) => [key(index), { type: "string" }]),
          ),
        },
      });
    expect(wide(30)).not.toBeNull();
    // Too many to show, or a key an answer could not carry back: declined, not cut short.
    expect(wide(31)).toBeNull();
    // A required answer longer than an answer may carry could never be given.
    expect(
      promptOf({
        mode: "form",
        message: "Essay",
        requestedSchema: {
          type: "object",
          properties: { essay: { type: "string", minLength: 4_001 } },
          required: ["essay"],
        },
      }),
    ).toBeNull();
    expect(wide(1, () => "k".repeat(101))).toBeNull();
    expect(
      promptOf({ mode: "url", message: "Go", url: "https://example.com/pay" } as never),
    ).toEqual({
      mode: "url",
      message: "Go",
      url: "https://example.com/pay",
    });
  });

  it("keeps how many choices to pick, and what was picked to start with", () => {
    const pick = promptOf({
      mode: "form",
      message: "Labels",
      requestedSchema: {
        type: "object",
        properties: {
          labels: {
            type: "array",
            items: { enum: ["bug", "ux", "docs"] },
            minItems: 1,
            maxItems: 2,
            default: ["bug"],
          },
        },
      } as never,
    });
    expect(pick?.mode === "form" && pick.fields[0]).toMatchObject({
      kind: "choices",
      min: 1,
      max: 2,
      default: ["bug"],
    });
    if (!pick) return;
    const answer = (labels: string[]) =>
      resultOf(pick, { action: "accept", values: { labels } }).action;
    expect(answer(["bug", "ux"])).toBe("accept");
    expect(answer(["bug", "ux", "docs"])).toBe("decline");
    // Optional and left empty: left out, not an answer of none that breaks its minimum.
    expect(resultOf(pick, { action: "accept", values: { labels: [] } })).toEqual({
      action: "accept",
      content: {},
    });
  });

  it("declines lists asking for more, or longer picks, than an answer can carry", () => {
    const list = (items: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      promptOf({
        mode: "form",
        message: "Pick",
        requestedSchema: {
          type: "object",
          properties: { picks: { type: "array", items, ...extra } },
        },
      } as never);
    expect(list({ enum: ["a", "b"] })).not.toBeNull();
    expect(list({ enum: ["a", "b"] }, { minItems: 51 })).toBeNull();
    expect(list({ enum: ["a", "x".repeat(501)] })).toBeNull();
  });

  it("sends only answers that fit the form, never half of one", () => {
    expect(
      resultOf(form!, { action: "accept", values: { project: "web", count: 3, labels: ["bug"] } }),
    ).toEqual({
      action: "accept",
      content: { project: "web", count: 3, labels: ["bug"] },
    });
    // Out of range, not a choice, or a required field missing: declined as a whole.
    expect(resultOf(form!, { action: "accept", values: { project: "web", count: 9 } })).toEqual({
      action: "decline",
    });
    expect(resultOf(form!, { action: "accept", values: { project: "ops", count: 1 } })).toEqual({
      action: "decline",
    });
    expect(resultOf(form!, { action: "accept", values: { count: 1 } })).toEqual({
      action: "decline",
    });
    expect(resultOf(form!, { action: "cancel" })).toEqual({ action: "cancel" });
  });
});
