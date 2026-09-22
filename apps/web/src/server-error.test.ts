import { describe, expect, it } from "vitest";
import {
  UNEXPECTED_FAILURE,
  newErrorReference,
  readServerError,
  unexpectedFailureBody,
} from "./server-error.ts";

describe("readServerError", () => {
  it("recovers the reference from an unexpected failure body", () => {
    const body = unexpectedFailureBody("K7F2QX");
    expect(readServerError(new Error(body))).toEqual({
      reason: null,
      reference: "K7F2QX",
      raw: body,
    });
    expect(body.startsWith(UNEXPECTED_FAILURE)).toBe(true);
  });

  it("keeps a server's own reason as something a person can read", () => {
    expect(readServerError(new Error("a schedule can run at most once an hour")).reason).toBe(
      "a schedule can run at most once an hour",
    );
  });

  it("says nothing for status words, the network, or a bug in the page", () => {
    expect(readServerError(new Error("Not found")).reason).toBeNull();
    expect(readServerError(new Error("Unauthorized")).reason).toBeNull();
    expect(readServerError(new TypeError("Failed to fetch")).reason).toBeNull();
    expect(readServerError(new TypeError("Cannot read properties of undefined")).reason).toBeNull();
    expect(readServerError(undefined).reason).toBeNull();
  });
});

describe("newErrorReference", () => {
  it("makes six characters a person can read back without mixing up 0/O or 1/I", () => {
    const reference = newErrorReference((length) => Uint8Array.from({ length }, (_, i) => i * 37));
    expect(reference).toMatch(/^[2-9A-HJ-NP-Z]{6}$/);
  });
});
