import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IntegrationAuthFailed } from "../errors.ts";
import { jiraCall } from "../jira/server/client.ts";
import { outlineCall } from "../outline/server/client.ts";
import { graphCall } from "../outlook/server/client.ts";
import type { Credential, IntegrationSession } from "./adapter.ts";

const identity = {
  connectionId: "connection",
  accountEpoch: "account",
  credentialRevision: "old",
};

afterEach(() => vi.unstubAllGlobals());

describe("request credential failures", () => {
  it.each(["outline", "outlook", "jira-api", "jira-oauth"] as const)(
    "%s keeps the failed request's snapshot while a successor becomes current",
    async (kind) => {
      let current: Credential =
        kind === "jira-api"
          ? { kind: "api_key", values: { email: "test@invalid.test", token: "old" }, identity }
          : { kind: "oauth", accessToken: "old", identity };
      const acquired = vi.fn(() => current);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const fetch = vi.fn(async () => {
        entered.resolve();
        await release.promise;
        return new Response("{}", { status: 401 });
      });
      vi.stubGlobal("fetch", fetch);
      const session: IntegrationSession = {
        config: { baseUrl: "https://outline.invalid", site: "https://snapshot.atlassian.net" },
        credential: Effect.sync(acquired),
        scope: Effect.succeed(null),
      };
      const request =
        kind === "outline"
          ? outlineCall(session, "auth.info", {})
          : kind === "outlook"
            ? graphCall(session, "GET", "/me")
            : jiraCall(session, "GET", "/myself");
      const failure = Effect.runPromise(Effect.flip(request));
      try {
        await entered.promise;
        current = {
          kind: "oauth",
          accessToken: "new",
          identity: { ...identity, credentialRevision: "new" },
        };
        release.resolve();
        const error = await failure;
        expect(error).toBeInstanceOf(IntegrationAuthFailed);
        expect(error).toMatchObject({ credential: identity });
        expect(acquired).toHaveBeenCalledOnce();
        expect(fetch).toHaveBeenCalledOnce();
      } finally {
        release.resolve();
        await failure;
      }
    },
  );
});
