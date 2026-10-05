import { describe, expect, it } from "vitest";
import { decodeAwsKeys, encodeAwsKeys } from "./aws-keys.ts";

describe("stored AWS keys", () => {
  it("round-trips access keys and reads nothing else as keys", () => {
    const keys = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalr/K7MDENG" };
    expect(decodeAwsKeys(encodeAwsKeys(keys))).toEqual(keys);
    // A bearer key left from before a switch is never taken for access keys.
    expect(decodeAwsKeys("ABSKQmVkcm9ja0FQSUtleQ")).toBeUndefined();
    expect(decodeAwsKeys('{"accessKeyId":"lowercase","secretAccessKey":"x"}')).toBeUndefined();
  });
});
