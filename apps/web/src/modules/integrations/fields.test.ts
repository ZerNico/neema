import { describe, expect, it } from "vitest";
import { fieldShown, readFields } from "./fields.ts";
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

describe("choices", () => {
  const ways: ReadonlyArray<IntegrationField> = [
    {
      key: "ways",
      label: "Ways",
      kind: "choices",
      required: true,
      options: [
        { value: "oauth", label: "Sign in" },
        { value: "anonymous", label: "Without an account" },
      ],
    },
    {
      key: "anonymous",
      label: "Without an account",
      kind: "choice",
      required: true,
      when: { key: "ways", values: ["anonymous"] },
      options: [
        { value: "open", label: "No key" },
        { value: "shared", label: "Shared key" },
      ],
    },
  ];
  const sharedKey = { when: { key: "anonymous", values: ["shared"] } };

  it("keeps options in their declared order and refuses ones not declared", () => {
    expect(readFields(ways.slice(0, 1), { ways: " anonymous  oauth " })).toEqual({
      values: { ways: "oauth anonymous" },
    });
    expect(readFields(ways.slice(0, 1), { ways: "oauth magic" })).toHaveProperty("error");
  });

  it("matches a condition against any ticked option, and not through a hidden field", () => {
    expect(fieldShown(ways[1]!, { ways: "oauth anonymous" }, ways)).toBe(true);
    expect(fieldShown(sharedKey, { ways: "oauth anonymous", anonymous: "shared" }, ways)).toBe(
      true,
    );
    // The leftover choice of an unticked way shows nothing.
    expect(fieldShown(sharedKey, { ways: "oauth", anonymous: "shared" }, ways)).toBe(false);
  });
});
