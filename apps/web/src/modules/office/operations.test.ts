import { describe, expect, it } from "vitest";
import { JobError } from "~/server/job-worker.ts";
import { OFFICE_FAMILIES, OFFICE_FAMILY_NAMES, officeFamilyOfFile } from "./families.ts";
import { operationEngine, xmlSafe } from "./operations.ts";

type Own = { readonly type: "shout"; readonly about: string };
const engine = operationEngine<Own>({
  operations: {
    setTitle: {
      about: "Set the title.",
      fields: {
        title: { type: "shout", about: "Upper-case title." },
        size: { type: "integer", min: 8, max: 72, about: "Size." },
        bold: { type: "boolean", about: "Bold." },
        align: { type: "string", max: 10, options: ["left", "center"], about: "Alignment." },
        slide: { type: "integer", min: 1, max: 9, about: "Slide." },
        ref: { type: "string", max: 10, about: "Ref." },
      },
      required: ["title"],
      exclusive: [["slide", "ref"]],
      change: ["set", "title"],
    },
    clear: { about: "Clear.", fields: {}, required: [], change: ["cleared"] },
  },
  maxOperations: 3,
  Error: JobError,
  own: {
    describe: () => "an upper-case word",
    value: (_field, raw, _path, _stage, wrong) =>
      typeof raw === "string" && raw === raw.toUpperCase() ? raw : wrong(),
    schema: (field) => ({ type: "string", description: field.about }),
  },
});

const failure = (input: unknown) => {
  try {
    engine.parse(input, undefined);
  } catch (error) {
    return error instanceof JobError ? `${error.code}: ${error.message}` : error;
  }
  return null;
};

describe("Office operation engine", () => {
  it("accepts the near misses models send and keeps canonical values", () => {
    expect(
      engine.parse(
        '[{"kind":"setTitle","title":"HELLO","size":"24","bold":"true","align":"Center","slide":2,"ref":null}]',
        undefined,
      ),
    ).toEqual([
      { kind: "setTitle", title: "HELLO", size: 24, bold: true, align: "center", slide: 2 },
    ]);
  });

  it("names the path, the expectation and what arrived", () => {
    expect(failure([{ kind: "setTitle", title: "hello", slide: 1 }])).toBe(
      "invalid_operation: operations[0] setTitle.title: expected an upper-case word; received a string",
    );
    expect(failure([{ kind: "setTitle", title: "HI", size: 99, slide: 1 }])).toBe(
      "invalid_operation: operations[0] setTitle.size: expected an integer from 8 to 72; received the number 99",
    );
    expect(failure([{ kind: "setTitle", title: "HI" }])).toBe(
      "invalid_operation: operations[0] setTitle: provide exactly one of slide, ref",
    );
    expect(failure([{ kind: "setTitle", slide: 1 }])).toBe(
      "invalid_operation: operations[0] setTitle: missing title (an upper-case word)",
    );
    expect(failure([{ kind: "setTitle", title: "HI", slide: 1, colour: "red" }])).toMatch(
      /unknown field "colour"; allowed: title, size/,
    );
    expect(failure([{ kind: "rename" }])).toBe(
      "invalid_operation: operations[0]: unknown kind; use one of setTitle, clear",
    );
    expect(failure(Array.from({ length: 4 }, () => ({ kind: "clear" })))).toMatch(
      /at most 3 operations; received 4 operations\. Split into smaller calls/,
    );
  });

  it("offers one schema branch per kind and summarizes changes for people", () => {
    const branches = (engine.jsonSchema.items as { anyOf: Array<Record<string, unknown>> }).anyOf;
    expect(branches.map((branch) => branch.required)).toEqual([["kind", "title"], ["kind"]]);
    expect(branches[0]!.properties).toMatchObject({
      kind: { enum: ["setTitle"] },
      title: { type: "string" },
      align: { enum: ["left", "center"] },
    });
    expect(
      engine.describeChanges([{ kind: "setTitle" }, { kind: "setTitle" }, { kind: "clear" }]),
    ).toBe("Set 2 titles and cleared");
  });

  it("refuses what XML cannot carry, keeping a valid surrogate pair", () => {
    expect(xmlSafe("tab\tand 😀")).toBe(true);
    expect(xmlSafe("\u0001")).toBe(false);
    expect(xmlSafe("\ud800")).toBe(false);
    expect(xmlSafe("￿")).toBe(false);
  });
});

describe("Office family registry", () => {
  it("decides a file's family by a specific media type, else by extension", () => {
    for (const family of OFFICE_FAMILY_NAMES) {
      const { mediaType, extension } = OFFICE_FAMILIES[family];
      expect(officeFamilyOfFile({ name: "file.bin", mediaType })).toBe(family);
      expect(
        officeFamilyOfFile({ name: `File.${extension.toUpperCase()}`, mediaType: undefined }),
      ).toBe(family);
    }
    expect(officeFamilyOfFile({ name: "deck.pptx", mediaType: "application/pdf" })).toBeNull();
  });
});
