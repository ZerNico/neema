import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { describe, expect, it } from "vitest";
import { fetchCatalog } from "./catalog.ts";
import { makeConnection } from "./connection.ts";

const bedrock = (profiles: Response) => {
  const urls: string[] = [];
  const fetch = async (url: RequestInfo | URL) => {
    urls.push(String(url));
    return String(url).includes("/inference-profiles")
      ? profiles
      : Response.json({ data: [{ id: "openai.gpt-oss-120b" }] });
  };
  const connection = makeConnection({
    provider: "p1",
    preset: "bedrock",
    baseUrl: "eu-central-1",
    credentials: { kind: "key", key: "ABSK-test" },
  })!;
  const run = fetchCatalog(connection).pipe(
    Effect.map((models) => models.map((model) => model.id)),
    Effect.provide(
      FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
    ),
  );
  return { urls, run: () => Effect.runPromise(run) };
};

describe("Bedrock catalog", () => {
  it("adds the account's active Claude inference profiles to mantle's listing", async () => {
    const catalog = bedrock(
      Response.json({
        inferenceProfileSummaries: [
          { inferenceProfileId: "eu.anthropic.claude-sonnet-4-6", status: "ACTIVE" },
          { inferenceProfileId: "global.anthropic.claude-opus-5-5", status: "ACTIVE" },
          // Not Claude: its profiles go to mantle, which takes none.
          { inferenceProfileId: "eu.meta.llama3-2-3b-instruct-v1:0", status: "ACTIVE" },
          { inferenceProfileId: "eu.anthropic.claude-3-haiku-20240307-v1:0", status: "LEGACY" },
        ],
      }),
    );
    expect(await catalog.run()).toEqual([
      "openai.gpt-oss-120b",
      "eu.anthropic.claude-sonnet-4-6",
      "global.anthropic.claude-opus-5-5",
    ]);
    expect(catalog.urls).toContain(
      "https://bedrock.eu-central-1.amazonaws.com/inference-profiles?typeEquals=SYSTEM_DEFINED&maxResults=1000",
    );
  });

  it("still lists mantle's models when listing profiles is not allowed", async () => {
    const catalog = bedrock(Response.json({ Message: "not authorized" }, { status: 403 }));
    expect(await catalog.run()).toEqual(["openai.gpt-oss-120b"]);
  });
});
