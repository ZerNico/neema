import { describe, expect, it } from "vitest";
import { english, localized, verbatim } from "~/i18n/localized.ts";
import { m } from "~/paraglide/messages.js";
import { fieldShown, readFields } from "./fields.ts";
import type { IntegrationField } from "./manifest.ts";

const fields: ReadonlyArray<IntegrationField> = [
  { key: "email", label: verbatim("Atlassian email"), kind: "email", required: true },
  { key: "token", label: verbatim("API token"), kind: "secret", required: true },
  { key: "site", label: verbatim("Site"), kind: "url", required: false },
];

describe("readFields", () => {
  it("trims, normalizes by kind and drops undeclared keys", () => {
    expect(
      readFields(fields, { email: " Ana@Example.com ", token: " t0k ", extra: "x", site: "" }),
    ).toEqual({ values: { email: "ana@example.com", token: "t0k" } });
  });

  const error = (input: Record<string, string>) => {
    const read = readFields(fields, input);
    return "error" in read ? read.error : null;
  };

  it("names the first field that is missing or malformed", () => {
    expect(english(error({ token: "t" })!)).toBe("Enter the Atlassian email.");
    expect(english(error({ email: "Ana <ana@example.com>", token: "t" })!)).toBe(
      "The Atlassian email is not an email address.",
    );
    expect(english(error({ email: "a@example.com", token: "t", site: "ftp://x" })!)).toBe(
      "The Site is not a web address.",
    );
  });

  it("names the field in the reader's language", () => {
    const [field] = fields;
    const germanLabel = { ...field!, label: localized(m.integrations_mcp_token_label) };
    const read = readFields([germanLabel], {});
    expect("error" in read && read.error("de")).toBe("Fülle „Token“ aus.");
  });
});

describe("choices", () => {
  const ways: ReadonlyArray<IntegrationField> = [
    {
      key: "ways",
      label: verbatim("Ways"),
      kind: "choices",
      required: true,
      options: [
        { value: "oauth", label: verbatim("Sign in") },
        { value: "anonymous", label: verbatim("Without an account") },
      ],
    },
    {
      key: "anonymous",
      label: verbatim("Without an account"),
      kind: "choice",
      required: true,
      when: { key: "ways", values: ["anonymous"] },
      options: [
        { value: "open", label: verbatim("No key") },
        { value: "shared", label: verbatim("Shared key") },
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
