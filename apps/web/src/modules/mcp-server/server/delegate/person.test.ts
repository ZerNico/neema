import { describe, expect, it } from "vitest";
import { elicitationSupport } from "./person.ts";

describe("elicitationSupport", () => {
  it("reads what a client can put to its person from its own capabilities", () => {
    expect(elicitationSupport({ elicitation: { form: {}, url: {} } })).toEqual({
      form: true,
      url: true,
    });
    expect(elicitationSupport({ elicitation: { url: {} } })).toEqual({ form: false, url: true });
    // The empty capability predates the two modes and means forms.
    expect(elicitationSupport({ elicitation: {} })).toEqual({ form: true, url: false });
  });

  it("assumes nothing a client did not declare", () => {
    for (const capabilities of [undefined, null, {}, { elicitation: null }, "elicitation"])
      expect(elicitationSupport(capabilities)).toEqual({ form: false, url: false });
  });
});
