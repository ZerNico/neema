import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Credential, IntegrationSession } from "../../server/adapter.ts";
import { jiraAdapter } from "./adapter.ts";

const SITE = "https://acme.atlassian.net";
const GATEWAY = "https://api.atlassian.com/ex/jira/cloud-1/rest/api/3";

interface Seen {
  method: string;
  url: string;
  authorization: string | null;
  body: unknown;
}
let requests: Seen[];
let throttleOnce: boolean;

const json = (status: number, body?: unknown, headers?: Record<string, string>) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    ...(headers ? { headers } : {}),
  });

const issue = (key: string, summary: string, status = "To Do") => ({
  id: key,
  key,
  fields: { summary, status: { name: status }, issuetype: { name: "Task" } },
});

const people = [
  { accountId: "u-ana", displayName: "Ana Lopez", emailAddress: "ana@acme.test" },
  { accountId: "u-anan", displayName: "Anand Rao", emailAddress: "anand@acme.test" },
];

/** A fake Jira: answers by path whichever route a request came by. */
const jira = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  const headers = new Headers(init?.headers);
  requests.push({ method, url: url.toString(), authorization: headers.get("authorization"), body });
  if (url.toString() === "https://api.atlassian.com/oauth/token/accessible-resources")
    return json(200, [
      { id: "cloud-other", url: "https://other.atlassian.net" },
      { id: "cloud-1", url: SITE },
    ]);
  const path = url.pathname.replace(/^.*\/rest\/api\/3/, "");
  if (throttleOnce) {
    throttleOnce = false;
    return json(429, { errorMessages: ["Slow down"] }, { "retry-after": "0" });
  }
  if (path === "/myself")
    return json(200, { accountId: "u-me", displayName: "Me", emailAddress: "me@acme.test" });
  if (path === "/search/jql")
    return json(200, { issues: [issue("PROJ-1", "Fix login")], nextPageToken: "t2" });
  if (path === "/issue/PROJ-1" && method === "GET")
    return json(200, {
      ...issue("PROJ-1", "Fix login", "In Progress"),
      fields: {
        ...issue("PROJ-1", "Fix login", "In Progress").fields,
        description: {
          type: "doc",
          version: 1,
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Users cannot sign in." }] },
          ],
        },
        issuelinks: [
          {
            type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
            outwardIssue: {
              key: "PROJ-2",
              fields: { summary: "Release", status: { name: "To Do" } },
            },
          },
        ],
      },
    });
  if (path === "/issue/PROJ-2" && method === "GET") return json(200, issue("PROJ-2", "Release"));
  if (path.startsWith("/issue/") && method === "GET" && !path.includes("/", 7))
    return json(404, {
      errorMessages: ["Issue does not exist or you do not have permission to see it."],
    });
  if (path === "/issue/PROJ-1/comment" && method === "GET")
    return json(200, {
      total: 1,
      comments: [
        {
          id: "c1",
          author: { accountId: "u-ana", displayName: "Ana Lopez" },
          created: "2026-10-01T10:00:00.000+0000",
          body: {
            type: "doc",
            version: 1,
            content: [{ type: "paragraph", content: [{ type: "text", text: "On it" }] }],
          },
        },
      ],
    });
  if (path === "/issue/PROJ-1/comment" && method === "POST") return json(201, { id: "c9" });
  if (path === "/issue/PROJ-1/transitions" && method === "GET")
    return json(200, {
      transitions: [
        { id: "21", name: "Start review", to: { name: "In Review" } },
        { id: "31", name: "Done", to: { name: "Done" } },
      ],
    });
  if (path === "/issue/PROJ-1/transitions" && method === "POST") return json(204);
  if (path === "/issueLinkType")
    return json(200, {
      issueLinkTypes: [
        { name: "Blocks", inward: "is blocked by", outward: "blocks" },
        { name: "Relates", inward: "relates to", outward: "relates to" },
      ],
    });
  if (path === "/issueLink") return json(201);
  if (path === "/issue/PROJ-1/assignee" && method === "PUT") return json(204);
  if (path === "/user/assignable/search") {
    const query = (url.searchParams.get("query") ?? "").toLowerCase();
    return json(
      200,
      people.filter(
        (person) =>
          person.displayName.toLowerCase().includes(query) || person.emailAddress.includes(query),
      ),
    );
  }
  if (path === "/issue" && method === "POST") {
    const fields = (body as { fields: Record<string, unknown> }).fields;
    if (!fields.priority)
      return json(400, { errorMessages: [], errors: { priority: "Priority is required." } });
    return json(201, { id: "10", key: "PROJ-7" });
  }
  return json(404, { errorMessages: [`No route for ${method} ${path}`] });
};

beforeEach(() => {
  requests = [];
  throttleOnce = false;
  vi.stubGlobal("fetch", vi.fn(jira));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const apiKey: Credential = { kind: "api_key", values: { email: "me@acme.test", token: "t0k" } };
const sessionWith = (credential: Credential): IntegrationSession => ({
  config: { site: SITE },
  credential: Effect.succeed(credential),
});
const session = sessionWith(apiKey);
const handlers = jiraAdapter.handlers;
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const prepared = (tool: string, args: unknown) => run(handlers[tool]!(session, args));
const executed = async (tool: string, args: unknown) => run((await prepared(tool, args)).execute);
const refusal = (tool: string, args: unknown) =>
  run(Effect.flip(handlers[tool]!(session, args))).then((error) =>
    "reason" in error ? error.reason : error.message,
  );
const sent = (method: string, suffix: string) =>
  requests.filter((request) => request.method === method && request.url.endsWith(suffix));

describe("jira adapter", () => {
  it("accepts only a Jira Cloud site and keys connections by it", () => {
    expect(jiraAdapter.normalizeConfig({ site: " Acme " })).toEqual({
      config: { site: SITE },
      fingerprint: "acme.atlassian.net",
    });
    expect(
      jiraAdapter.normalizeConfig({ site: "https://acme.atlassian.net/jira/software" }),
    ).toEqual({
      config: { site: SITE },
      fingerprint: "acme.atlassian.net",
    });
    expect(jiraAdapter.normalizeConfig({ site: "jira.example.com" })).toHaveProperty("error");
    expect(jiraAdapter.normalizeConfig({ site: "" })).toHaveProperty("error");
  });

  it("signs an API token with its email at the site, and OAuth through the gateway", async () => {
    await run(jiraAdapter.verify(session));
    expect(requests[0]).toMatchObject({
      url: `${SITE}/rest/api/3/myself`,
      authorization: `Basic ${Buffer.from("me@acme.test:t0k").toString("base64")}`,
    });

    requests = [];
    const label = await run(jiraAdapter.verify(sessionWith({ kind: "oauth", accessToken: "a1" })));
    expect(label).toEqual({ accountLabel: "me@acme.test · acme.atlassian.net" });
    // The cloud id is the configured site's, not the first one the account can reach.
    expect(requests.map((request) => request.url)).toContain(`${GATEWAY}/myself`);
    expect(requests.every((request) => request.authorization === "Bearer a1")).toBe(true);
  });

  it("searches by words as quoted JQL and cites what it found", async () => {
    const result = await executed("search_issues", { text: 'login "SSO"' });
    expect(sent("POST", "/search/jql")[0]?.body).toMatchObject({
      jql: 'text ~ "login \\"SSO\\"" ORDER BY updated DESC',
    });
    expect(result.output).toMatchObject({ issues: [{ key: "PROJ-1" }], nextPageToken: "t2" });
    expect(result.sources?.[0]).toMatchObject({ url: `${SITE}/browse/PROJ-1`, read: false });
    expect(await refusal("search_issues", { jql: "project = X", text: "y" })).toMatch(/either/);
  });

  it("reads an issue as Markdown with links worded from its side", async () => {
    const result = await executed("read_issue", { key: "proj-1" });
    expect(result.output).toMatchObject({
      key: "PROJ-1",
      status: "In Progress",
      description: "Users cannot sign in.",
      links: [{ relation: "blocks", key: "PROJ-2" }],
      transitions: ["Start review (to In Review)", "Done"],
      comments: [{ author: "Ana Lopez", body: "On it" }],
      nextCommentsFrom: null,
    });
    expect(result.sources?.[0]).toMatchObject({ read: true });
  });

  it("retries a throttled request once", async () => {
    throttleOnce = true;
    await run(jiraAdapter.verify(session));
    expect(sent("GET", "/myself")).toHaveLength(2);
  });

  it("names the person before approval, and asks when a name is ambiguous", async () => {
    expect(await refusal("assign_issue", { key: "PROJ-1", assignee: "ana" })).toBe(
      "Several people match “ana”: Ana Lopez, Anand Rao. Pass the full name or email.",
    );
    const call = await prepared("assign_issue", { key: "PROJ-1", assignee: "Ana Lopez" });
    expect(call.summary).toBe("PROJ-1 · Fix login → Ana Lopez");
    await run(call.execute);
    expect(sent("PUT", "/issue/PROJ-1/assignee")[0]?.body).toEqual({ accountId: "u-ana" });

    const none = await prepared("assign_issue", { key: "PROJ-1", assignee: "none" });
    await run(none.execute);
    expect(sent("PUT", "/issue/PROJ-1/assignee")[1]?.body).toEqual({ accountId: null });
  });

  it("creates an issue from Markdown and passes Jira's field errors on", async () => {
    expect(await refusal("create_issue", { project: "PROJ", type: "Task" })).toBe(
      "Pass `summary`.",
    );
    const failed = await run(
      Effect.flip(
        (await prepared("create_issue", { project: "proj", type: "Task", summary: "New" })).execute,
      ),
    );
    expect(failed).toMatchObject({ message: "Jira: priority: Priority is required." });

    const result = await executed("create_issue", {
      project: "PROJ",
      type: "Task",
      summary: "New",
      priority: "High",
      description: "Do **this**",
      labels: ["ops"],
    });
    expect(result.link).toEqual({ title: "PROJ-7: New", url: `${SITE}/browse/PROJ-7` });
    expect(sent("POST", "/rest/api/3/issue").at(-1)?.body).toMatchObject({
      fields: {
        project: { key: "PROJ" },
        labels: ["ops"],
        description: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ text: "Do " }, { text: "this", marks: [{ type: "strong" }] }],
            },
          ],
        },
      },
    });
    expect(
      await refusal("create_issue", {
        project: "PROJ",
        type: "Task",
        summary: "x",
        labels: ["two words"],
      }),
    ).toMatch(/spaces/);
  });

  it("links in the direction Jira shows, whichever wording was used", async () => {
    const blocks = await prepared("link_issues", { from: "PROJ-1", type: "blocks", to: "PROJ-2" });
    expect(blocks.summary).toBe("PROJ-1 blocks PROJ-2 · Fix login");
    await run(blocks.execute);
    const blocked = await prepared("link_issues", {
      from: "PROJ-2",
      type: "is blocked by",
      to: "PROJ-1",
    });
    await run(blocked.execute);
    // Both say PROJ-1 blocks PROJ-2; Jira shows the outward words on `inwardIssue`.
    const bodies = sent("POST", "/issueLink").map((request) => request.body);
    expect(bodies).toEqual([
      { type: { name: "Blocks" }, inwardIssue: { key: "PROJ-1" }, outwardIssue: { key: "PROJ-2" } },
      { type: { name: "Blocks" }, inwardIssue: { key: "PROJ-1" }, outwardIssue: { key: "PROJ-2" } },
    ]);
    expect(await refusal("link_issues", { from: "PROJ-1", type: "causes", to: "PROJ-2" })).toBe(
      "Jira has no link “causes”. It has: blocks / is blocked by, relates to / relates to.",
    );
  });

  it("moves an issue by status name and comments after", async () => {
    const call = await prepared("transition_issue", {
      key: "PROJ-1",
      to: "in review",
      comment: "Ready",
    });
    expect(call.summary).toBe("PROJ-1 · Fix login: In Progress → In Review");
    await run(call.execute);
    expect(sent("POST", "/issue/PROJ-1/transitions")[0]?.body).toEqual({
      transition: { id: "21" },
    });
    expect(sent("POST", "/issue/PROJ-1/comment")).toHaveLength(1);
    expect(await refusal("transition_issue", { key: "PROJ-1", to: "Archived" })).toBe(
      "PROJ-1 cannot move to “Archived” from In Progress. It can take: Start review, Done.",
    );
  });

  it("refuses a missing issue before anything is approved", async () => {
    expect(await refusal("add_comment", { key: "PROJ-404", body: "hi" })).toBe(
      "Jira: Issue does not exist or you do not have permission to see it.",
    );
    expect(await refusal("add_comment", { key: "not a key", body: "hi" })).toMatch(/issue key/);
  });
});
