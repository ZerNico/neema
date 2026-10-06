import { describe, expect, it } from "vitest";
import { readFields } from "./fields.ts";
import type { IntegrationField } from "./manifest.ts";

const fields: ReadonlyArray<IntegrationField> = [
  { key: "email", label: "Atlassian email", kind: "email", required: true },
  { key: "token", label: "API token", kind: "secret", required: true },
  { key: "site", label: "Site", kind: "url", required: false },
];

describe("readFields", () => {
  it("trims, normalizes by kind and drops undeclared keys", () => {
    expect(
      readFields(fields, { email: " Ana@Example.com ", token: " t0k ", extra: "x", site: "" }),
    ).toEqual({ values: { email: "ana@example.com", token: "t0k" } });
  });

  it("names the first field that is missing or malformed", () => {
    expect(readFields(fields, { token: "t" })).toEqual({ error: "Enter the Atlassian email." });
    expect(readFields(fields, { email: "Ana <ana@example.com>", token: "t" })).toEqual({
      error: "The Atlassian email is not an email address.",
    });
    expect(readFields(fields, { email: "a@example.com", token: "t", site: "ftp://x" })).toEqual({
      error: "The Site is not a web address.",
    });
  });
});
