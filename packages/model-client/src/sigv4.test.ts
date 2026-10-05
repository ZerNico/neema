import { describe, expect, it } from "vitest";
import { amzDate, authorization, bedrockScope, sha256Hex } from "./sigv4.ts";

const keys = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};
const date = new Date("2015-08-30T12:36:00Z");

describe("SigV4", () => {
  it("matches AWS's get-vanilla test vector", async () => {
    expect(
      await authorization({
        method: "GET",
        url: new URL("https://example.amazonaws.com/"),
        headers: { "x-amz-date": amzDate(date) },
        payloadHash: await sha256Hex(""),
        region: "us-east-1",
        service: "service",
        keys,
        date,
      }),
    ).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  // Pinned from the aws4 library, which signed the same request identically.
  it("sorts the query and scopes a mantle request to its own service", async () => {
    const payloadHash = await sha256Hex("");
    expect(
      await authorization({
        method: "GET",
        url: new URL("https://bedrock-mantle.eu-central-1.api.aws/v1/models?b=2&a=1&a=0"),
        headers: { "x-amz-date": amzDate(date), "x-amz-content-sha256": payloadHash },
        payloadHash,
        region: "eu-central-1",
        service: "bedrock-mantle",
        keys,
        date,
      }),
    ).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/eu-central-1/bedrock-mantle/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=6db23b280af8450e7be373cbbc7cc71ef6b97be460c53e036dfff46348e82bc2",
    );
  });

  it("reads region and signing name from Bedrock hosts only", () => {
    expect(bedrockScope(new URL("https://bedrock-mantle.us-east-2.api.aws/v1"))).toEqual({
      region: "us-east-2",
      service: "bedrock-mantle",
    });
    expect(
      bedrockScope(new URL("https://bedrock-runtime.eu-west-1.amazonaws.com/openai/v1")),
    ).toEqual({ region: "eu-west-1", service: "bedrock" });
    expect(bedrockScope(new URL("https://bedrock.eu-central-1.amazonaws.com/"))).toEqual({
      region: "eu-central-1",
      service: "bedrock",
    });
    expect(bedrockScope(new URL("https://api.openai.com/v1"))).toBeNull();
  });
});
