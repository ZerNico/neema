import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSourceIndexer } from "~/modules/tools/server/source-indexer.ts";
import type { UnattendedGrant } from "../../consent.ts";
import type { AdapterFailure } from "../../server/adapter.ts";
import type { IntegrationApprovals } from "../../server/approvals.ts";
import type { ConnectedSession } from "../../server/credentials.ts";
import { prepareIntegrationTools, shippedTools } from "../../server/tools.ts";
import { outlookManifest } from "../manifest.ts";
import type { IntegrationModelResult } from "../../tool-schema.ts";
import { outlookAdapter } from "./adapter.ts";

interface Draft {
  id: string;
  subject: string;
  isDraft: boolean;
  to: string[];
  cc: string[];
  bcc: string[];
}

/** A fake Graph: drafts it holds, and every request it saw. */
let drafts: Map<string, Draft>;
let requests: Array<{ method: string; path: string; body: unknown }>;
let sent: Array<{ subject: string; to: string[]; cc: string[]; bcc: string[] }>;
let failNextSend: number | null;

const recipients = (addresses: string[]) =>
  addresses.map((address) => ({ emailAddress: { address } }));
const addressesOf = (value: unknown) =>
  ((value ?? []) as Array<{ emailAddress: { address: string } }>).map(
    (entry) => entry.emailAddress.address,
  );
const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

const graph = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  const path = url.pathname.replace(/^\/v1\.0/, "");
  requests.push({ method, path, body });
  if (url.origin !== "https://graph.microsoft.com") return json(404);
  const draftPath = path.match(/^\/me\/messages\/([^/]+)(\/send)?$/);
  if (draftPath) {
    const draft = drafts.get(decodeURIComponent(draftPath[1]!));
    if (!draft) return json(404, { error: { message: "Not found" } });
    if (method === "GET")
      return json(200, {
        id: draft.id,
        subject: draft.subject,
        isDraft: draft.isDraft,
        toRecipients: recipients(draft.to),
        ccRecipients: recipients(draft.cc),
        bccRecipients: recipients(draft.bcc),
      });
    if (method === "PATCH") {
      const changes = body as Record<string, unknown>;
      draft.to = addressesOf(changes.toRecipients);
      draft.cc = addressesOf(changes.ccRecipients);
      draft.bcc = addressesOf(changes.bccRecipients);
      return json(200, { id: draft.id });
    }
    if (draftPath[2]) {
      if (failNextSend !== null) {
        const status = failNextSend;
        failNextSend = null;
        return json(status, { error: { message: "Unavailable" } });
      }
      sent.push({ subject: draft.subject, to: draft.to, cc: draft.cc, bcc: draft.bcc });
      drafts.delete(draft.id);
      return json(202);
    }
  }
  if (path === "/me/sendMail" && method === "POST") {
    const message = (body as { message: Record<string, unknown> }).message;
    sent.push({
      subject: String(message.subject),
      to: addressesOf(message.toRecipients),
      cc: addressesOf(message.ccRecipients),
      bcc: [],
    });
    return json(202);
  }
  if (path === "/me/events" && method === "POST") {
    const event = body as { subject: string };
    return json(201, {
      id: "e1",
      subject: event.subject,
      webLink: "https://outlook.office.com/e1",
    });
  }
  return json(404, { error: { message: `No route for ${method} ${path}` } });
};

beforeEach(() => {
  drafts = new Map();
  requests = [];
  sent = [];
  failNextSend = null;
  vi.stubGlobal("fetch", vi.fn(graph));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const session: ConnectedSession = {
  config: { tenant: "organizations" },
  credential: Effect.succeed({ kind: "oauth", accessToken: "token" }),
  scope: Effect.succeed(null),
  connectionId: "connection",
  account: "ana@example.com",
  accountEpoch: "epoch",
  configIdentity: "config",
  integration: { id: "outlook", kind: "outlook", name: "Outlook" },
  adapter: outlookAdapter,
  tools: shippedTools(outlookManifest, outlookAdapter),
  authKind: "oauth",
};
const handlers = outlookAdapter.handlers;
const refusal = (prepare: Effect.Effect<unknown, AdapterFailure>) =>
  Effect.runPromise(
    Effect.flip(prepare).pipe(
      Effect.map((error) => (error._tag === "IntegrationRejected" ? error.reason : error._tag)),
    ),
  );
const draft = (id: string, fields: Partial<Draft> = {}) =>
  drafts.set(id, {
    id,
    subject: "Weekly numbers",
    isDraft: true,
    to: [],
    cc: [],
    bcc: [],
    ...fields,
  });

describe("Outlook adapter", () => {
  it("reads a draft's own recipients, then sends exactly those", async () => {
    draft("d1", { to: ["Ana@Example.com"], cc: ["bo@example.com"] });
    const prepared = await Effect.runPromise(handlers.send_mail!(session, { draftId: "d1" }));
    expect(prepared.reach).toEqual({
      allowance: "send",
      targets: ["ana@example.com", "bo@example.com"],
    });
    expect(prepared.summary).toBe("“Weekly numbers” to ana@example.com, bo@example.com");
    expect(sent).toEqual([]);
    // Someone adds a recipient after the check; the send still goes to the checked ones.
    drafts.get("d1")!.cc.push("eve@example.com");
    await Effect.runPromise(prepared.execute);
    expect(sent).toEqual([
      { subject: "Weekly numbers", to: ["ana@example.com"], cc: ["bo@example.com"], bcc: [] },
    ]);
  });

  it("refuses a draft with Bcc, and a message that is not a draft", async () => {
    draft("d1", { to: ["ana@example.com"], bcc: ["hidden@example.com"] });
    draft("m1", { to: ["ana@example.com"], isDraft: false });
    const bcc = await refusal(handlers.send_mail!(session, { draftId: "d1" }));
    const sentMessage = await refusal(handlers.send_mail!(session, { draftId: "m1" }));
    expect(bcc).toMatch(/Bcc/);
    expect(sentMessage).toMatch(/not a draft/);
  });

  it("names an address it cannot read instead of dropping it", async () => {
    const reason = await refusal(
      handlers.send_mail!(session, {
        to: ["ana@example.com", "Bo <bo@example.com>"],
        subject: "Hi",
        body: "Hello",
      }),
    );
    expect(reason).toMatch(/“Bo <bo@example.com>” in `to`/);
    expect(requests).toEqual([]);
  });

  it("counts an event's attendees as invitations, and an event alone as none", async () => {
    const invite = await Effect.runPromise(
      handlers.create_event!(session, {
        subject: "Review",
        start: "2026-10-07T14:00:00",
        end: "2026-10-07T15:00:00",
        timeZone: "Europe/Berlin",
        attendees: "ana@example.com; bo@example.com",
      }),
    );
    expect(invite.reach).toEqual({
      allowance: "invite",
      targets: ["ana@example.com", "bo@example.com"],
    });
    const alone = await Effect.runPromise(
      handlers.create_event!(session, {
        subject: "Focus",
        start: "2026-10-07T09:00:00",
        end: "2026-10-07T10:00:00",
      }),
    );
    expect(alone.reach?.targets).toEqual([]);
    const result = await Effect.runPromise(invite.execute);
    expect(result.link).toEqual({ title: "Review", url: "https://outlook.office.com/e1" });
    expect(requests.at(-1)?.body).toMatchObject({
      start: { dateTime: "2026-10-07T14:00:00", timeZone: "Europe/Berlin" },
    });
  });
});

describe("sending under a schedule's allowance", () => {
  const counted = new Map<string, number>();
  const approvals: IntegrationApprovals["Service"] = {
    request: vi.fn(() => Effect.succeed({ answer: "allow" as const, via: null })),
    elicit: () => Effect.succeed({ action: "cancel" as const }),
    answer: () => Effect.succeed(false),
    decide: () => Effect.succeed(false),
    get: () => Effect.succeed(null),
    pending: () => Effect.succeed([]),
  };

  const tools = (unattended: UnattendedGrant, permissions = {}) => {
    counted.clear();
    const prepared = prepareIntegrationTools({
      offered: [
        {
          connectionId: "connection",
          integrationId: "outlook",
          session,
          scope: null,
          unattended,
          permissions,
        },
      ],
      indexer: createSourceIndexer([]),
      approvals,
      owner: { userId: "u1", conversationId: "c1", messageId: "m1" },
      permissionsFor: () => Effect.succeed({ permissions, allowedInChat: ["create_event"] }),
      sessionFor: () => Effect.succeed(session),
      rowIdFor: (id) => Effect.succeed(`row-${id}`),
      reportAuthFailure: () => Effect.void,
      reportMissingScopes: () => Effect.void,
      allowanceUses: {
        reserve: (_integration, allowance) =>
          Effect.sync(() => {
            const used = counted.get(allowance.id) ?? 0;
            if (used >= allowance.cap) return false;
            counted.set(allowance.id, used + 1);
            return true;
          }),
        release: (_integration, allowance) =>
          Effect.sync(() => counted.set(allowance.id, (counted.get(allowance.id) ?? 1) - 1)),
      },
    })!;
    return (tool: string, args: Record<string, unknown>, callId = "call") =>
      Effect.runPromise(
        (
          prepared.group.handlers[`int_outlook__${tool}`] as (
            args: unknown,
            context: { toolCallId: string },
          ) => Effect.Effect<IntegrationModelResult>
        )(args, { toolCallId: callId }),
      );
  };
  const schedule = (allowances: Record<string, string[]>) => tools({ access: "write", allowances });
  const compose = (to: string[], cc: string[] = []) => ({ to, cc, subject: "Report", body: "Hi" });

  it("sends to listed addresses and refuses anyone else, by name", async () => {
    const send = schedule({ send: ["ana@example.com", "bo@example.com"] });
    expect(await send("send_mail", compose(["ana@example.com"]))).toMatchObject({ ok: true });
    const outside = await send("send_mail", compose(["ana@example.com"], ["eve@example.com"]));
    expect(outside).toMatchObject({ ok: false, refused: true });
    expect(outside.error).toMatch(/eve@example\.com is not listed/);
    expect(sent.map((message) => message.to)).toEqual([["ana@example.com"]]);
  });

  it("checks a draft's stored recipients, not the model's word", async () => {
    draft("d1", { to: ["ana@example.com"], cc: ["eve@example.com"] });
    const send = schedule({ send: ["ana@example.com"] });
    const result = await send("send_mail", { draftId: "d1" });
    expect(result).toMatchObject({ ok: false, refused: true });
    expect(sent).toEqual([]);
  });

  it("keeps sending and inviting apart", async () => {
    const run = schedule({ invite: ["ana@example.com"] });
    const result = await run("send_mail", compose(["ana@example.com"]));
    expect(result.error).toMatch(/may not contact anyone/);
    const invite = await run("create_event", {
      subject: "Sync",
      start: "2026-10-07T14:00:00",
      end: "2026-10-07T15:00:00",
      attendees: ["ana@example.com"],
    });
    expect(invite).toMatchObject({ ok: true });
  });

  it("stops at the cap, even for calls made at once", async () => {
    const send = schedule({ send: ["ana@example.com"] });
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => send("send_mail", compose(["ana@example.com"]), `call-${n}`)),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(3);
    expect(results.find((result) => !result.ok)?.error).toMatch(/at most 3 times/);
    expect(sent).toHaveLength(3);
  });

  it("does not reserve an allowance for a queued send whose consent was revoked", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const queued = Promise.withResolvers<void>();
    let checks = 0;
    let blocked = false;
    const reserve = vi.fn(() => Effect.succeed(true));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/sendMail")) {
          entered.resolve();
          await release.promise;
        }
        return graph(input, init);
      }),
    );
    const prepared = prepareIntegrationTools({
      offered: [
        {
          connectionId: "connection",
          integrationId: "outlook",
          session,
          scope: null,
          unattended: { access: "write", allowances: { send: ["ana@example.com"] } },
          permissions: {},
        },
      ],
      indexer: createSourceIndexer([]),
      approvals,
      owner: { userId: "u1", conversationId: "c1", messageId: "m1" },
      permissionsFor: () =>
        Effect.sync(() => {
          if (++checks === 5) queued.resolve();
          return {
            permissions: { send_mail: blocked ? ("block" as const) : ("allow" as const) },
            allowedInChat: [],
          };
        }),
      sessionFor: () => Effect.succeed(session),
      rowIdFor: () => Effect.succeed("row"),
      reportAuthFailure: () => Effect.void,
      reportMissingScopes: () => Effect.void,
      allowanceUses: { reserve, release: () => Effect.void },
    })!;
    const send = prepared.group.handlers.int_outlook__send_mail as (
      args: Record<string, unknown>,
      context: { toolCallId: string },
    ) => Effect.Effect<IntegrationModelResult>;
    const first = Effect.runPromise(send(compose(["ana@example.com"]), { toolCallId: "first" }));
    let second: Promise<IntegrationModelResult> | undefined;
    try {
      await entered.promise;
      second = Effect.runPromise(send(compose(["ana@example.com"]), { toolCallId: "second" }));
      await queued.promise;
      blocked = true;
      release.resolve();
      expect(await first).toMatchObject({ ok: true });
      expect(await second).toMatchObject({ ok: false, refused: true });
      expect(reserve).toHaveBeenCalledOnce();
      expect(sent).toHaveLength(1);
    } finally {
      release.resolve();
      await first;
      await second;
    }
  });

  it("gives a use back only when the send certainly failed", async () => {
    const send = schedule({ send: ["ana@example.com"] });
    draft("d1", { to: ["ana@example.com"] });
    failNextSend = 400;
    expect(await send("send_mail", { draftId: "d1" })).toMatchObject({ ok: false });
    expect(counted.get("send")).toBe(0);
    failNextSend = 503;
    expect(await send("send_mail", { draftId: "d1" })).toMatchObject({ ok: false });
    // A 503 is not retried for a send, and may have gone out: the use stays spent.
    expect(counted.get("send")).toBe(1);
    expect(requests.filter((request) => request.path.endsWith("/send"))).toHaveLength(2);
  });

  it("refuses an invitation unattended without an allowance, but not a plain event", async () => {
    const run = tools({ access: "write", allowances: {} });
    const plain = await run("create_event", {
      subject: "Focus",
      start: "2026-10-07T09:00:00",
      end: "2026-10-07T10:00:00",
    });
    expect(plain).toMatchObject({ ok: true });
    const invite = await run("create_event", {
      subject: "Sync",
      start: "2026-10-07T14:00:00",
      end: "2026-10-07T15:00:00",
      attendees: ["ana@example.com"],
    });
    expect(invite).toMatchObject({ ok: false, refused: true });
  });

  it("asks before inviting with someone present, as a destructive call", async () => {
    // "Always allow in this chat" covers plain events here, never invitations.
    const run = tools(null);
    vi.mocked(approvals.request).mockClear();
    await run("create_event", {
      subject: "Focus",
      start: "2026-10-07T09:00:00",
      end: "2026-10-07T10:00:00",
    });
    expect(approvals.request).not.toHaveBeenCalled();
    await run("create_event", {
      subject: "Sync",
      start: "2026-10-07T14:00:00",
      end: "2026-10-07T15:00:00",
      attendees: ["ana@example.com"],
    });
    expect(approvals.request).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({ access: "destructive", targets: ["ana@example.com"] }),
    );
  });
});

describe("several accounts of one integration", () => {
  const approvals: IntegrationApprovals["Service"] = {
    request: vi.fn(() => Effect.succeed({ answer: "allow" as const, via: null })),
    elicit: () => Effect.succeed({ action: "cancel" as const }),
    answer: () => Effect.succeed(false),
    decide: () => Effect.succeed(false),
    get: () => Effect.succeed(null),
    pending: () => Effect.succeed([]),
  };
  const as = (connectionId: string, account: string, accessToken: string): ConnectedSession => ({
    ...session,
    connectionId,
    account,
    credential: Effect.succeed({ kind: "oauth", accessToken }),
  });
  const work = as("work", "Work", "work-token");
  const home = as("home", "Home", "home-token");
  const permissionsByAccount: Record<string, Record<string, "allow" | "ask" | "block">> = {
    work: { send_mail: "allow" },
    home: { send_mail: "block" },
  };

  /** The tools as a chat with both accounts on gets them, and the token each request carried. */
  const prepare = (accounts: ReadonlyArray<ConnectedSession>) => {
    const tokens: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        tokens.push(new Headers(init?.headers).get("authorization") ?? "");
        return graph(input, init);
      }),
    );
    const reserved: string[] = [];
    const prepared = prepareIntegrationTools({
      offered: accounts.map((account) => ({
        connectionId: account.connectionId,
        integrationId: "outlook",
        session: account,
        scope: null,
        unattended: null,
        permissions: permissionsByAccount[account.connectionId] ?? {},
      })),
      indexer: createSourceIndexer([]),
      approvals,
      owner: { userId: "u1", conversationId: "c1", messageId: "m1" },
      permissionsFor: (connectionId) =>
        Effect.succeed({
          permissions: permissionsByAccount[connectionId] ?? {},
          allowedInChat: [],
        }),
      sessionFor: (connectionId) =>
        Effect.succeed(accounts.find((account) => account.connectionId === connectionId) ?? null),
      rowIdFor: (id) => Effect.succeed(`row-${id}`),
      reportAuthFailure: () => Effect.void,
      reportMissingScopes: () => Effect.void,
      allowanceUses: {
        reserve: (connectionId) => Effect.sync(() => (reserved.push(connectionId), true)),
        release: () => Effect.void,
      },
    })!;
    const call = (tool: string, args: Record<string, unknown>, callId = "call") =>
      Effect.runPromise(
        (
          prepared.group.handlers[`int_outlook__${tool}`] as (
            args: unknown,
            context: { toolCallId: string },
          ) => Effect.Effect<IntegrationModelResult>
        )(args, { toolCallId: callId }),
      );
    return { prepared, call, tokens, reserved };
  };
  const message = { to: ["ana@example.com"], subject: "Report", body: "Hi" };

  it("offers one tool, and runs it as the account the call names, never another", async () => {
    const { prepared, call, tokens } = prepare([work, home]);
    // One send tool for both accounts, not two near-identical ones.
    expect([...prepared.names.keys()].filter((name) => name.endsWith("__send_mail"))).toEqual([
      "int_outlook__send_mail",
    ]);
    expect(prepared.names.get("int_outlook__send_mail")?.chooses).toBe(true);

    const unnamed = await call("send_mail", message);
    expect(unnamed).toMatchObject({ ok: false });
    expect(JSON.stringify(unnamed)).toMatch(/“Work”/);
    const unknown = await call("send_mail", { ...message, account: "Billing" });
    expect(JSON.stringify(unknown)).toMatch(/no Outlook account “Billing”/);
    expect(sent).toEqual([]);

    // Sending is blocked for Home: named, it is refused rather than sent from Work.
    const blocked = await call("send_mail", { ...message, account: "home" });
    expect(blocked).toMatchObject({ ok: false, refused: true });
    expect(sent).toEqual([]);

    expect(await call("send_mail", { ...message, account: "Work" }, "sent")).toMatchObject({
      ok: true,
    });
    expect(sent).toHaveLength(1);
    expect(tokens.every((token) => token === "Bearer work-token")).toBe(true);
    // The account argument is ours; the service never sees it.
    expect(JSON.stringify(requests.map((request) => request.body))).not.toMatch(/"account"/);
    expect(prepared.take("sent").account).toEqual({ connectionId: "work", name: "Work" });
  });

  it("tells two accounts left under one label apart", async () => {
    const { call } = prepare([as("a", "Token", "a-token"), as("b", "Token", "b-token")]);
    const listed = await call("list_events", {});
    expect(JSON.stringify(listed)).toMatch(/“Token”, “Token 2”/);
  });

  it("needs no account argument with one account on", async () => {
    const { prepared, call, tokens } = prepare([work]);
    expect(prepared.names.get("int_outlook__send_mail")?.chooses).toBe(false);
    expect(await call("send_mail", message)).toMatchObject({ ok: true });
    expect(tokens.every((token) => token === "Bearer work-token")).toBe(true);
  });
});
