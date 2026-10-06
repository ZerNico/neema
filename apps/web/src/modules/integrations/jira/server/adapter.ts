import { Effect } from "effect";
import { IntegrationRejected } from "../../errors.ts";
import { INTEGRATION_LIMITS } from "../../schema.ts";
import {
  integrationHandlers,
  ready,
  type AdapterSource,
  type IntegrationAdapter,
  type IntegrationSession,
} from "../../server/adapter.ts";
import { JIRA_TOOLS } from "../tools.ts";
import { adfToMarkdown, markdownToAdf } from "./adf.ts";
import {
  issueUrl,
  jiraCall,
  jiraPath,
  siteOf,
  type JiraComment,
  type JiraIssue,
  type JiraIssueLink,
  type JiraLinkedIssue,
  type JiraUser,
} from "./client.ts";

const text = (value: string | undefined) => (value?.trim() ? value.trim() : null);
const reject = (reason: string) => Effect.fail(new IntegrationRejected({ reason }));
const same = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" }) === 0;

const SEARCH_RESULTS = 20;
const COMMENTS_PER_READ = 20;
const LIST_FIELDS = ["summary", "status", "issuetype", "priority", "assignee", "updated"];
const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/;
const PROJECT_KEY = /^[A-Z][A-Z0-9_]*$/;

const issueKey = (value: string | undefined, field: string) => {
  const key = text(value)?.toUpperCase();
  return key && ISSUE_KEY.test(key)
    ? Effect.succeed(key)
    : reject(`Pass \`${field}\` as an issue key such as PROJ-123.`);
};

/** Labels as a list; Jira refuses spaces in one, so that is said before asking it. */
const labelList = (value: unknown) => {
  if (value === undefined) return Effect.succeed(undefined);
  const raw =
    typeof value === "string"
      ? value.split(",")
      : Array.isArray(value) && value.every((entry) => typeof entry === "string")
        ? (value as string[])
        : null;
  if (!raw) return reject("`labels` must be a list of labels.");
  const labels = [...new Set(raw.map((entry) => entry.trim()).filter(Boolean))];
  const spaced = labels.find((label) => /\s/.test(label));
  return spaced ? reject(`Labels cannot contain spaces (“${spaced}”).`) : Effect.succeed(labels);
};

/** A quoted JQL string literal. */
const jqlString = (value: string) => `"${value.replace(/["\\]/g, "\\$&")}"`;

const who = (user: JiraUser | null | undefined) =>
  user ? (user.displayName ?? user.emailAddress ?? user.accountId) : null;

const brief = (issue: JiraIssue) => ({
  key: issue.key,
  summary: issue.fields.summary ?? "",
  type: issue.fields.issuetype?.name ?? null,
  status: issue.fields.status?.name ?? null,
  priority: issue.fields.priority?.name ?? null,
  assignee: who(issue.fields.assignee),
  updated: issue.fields.updated ?? null,
});

const linked = (issue: JiraLinkedIssue) => ({
  key: issue.key,
  summary: issue.fields?.summary ?? "",
  status: issue.fields?.status?.name ?? null,
});

/** A link as Jira words it from this issue's side. */
const linkLine = (link: JiraIssueLink) =>
  link.outwardIssue
    ? { relation: link.type.outward, ...linked(link.outwardIssue) }
    : link.inwardIssue
      ? { relation: link.type.inward, ...linked(link.inwardIssue) }
      : null;

const source = (
  session: IntegrationSession,
  issue: JiraIssue,
  snippet: string,
  read: boolean,
): AdapterSource => ({
  externalId: issue.key,
  title: `${issue.key}: ${issue.fields.summary ?? ""}`,
  url: issueUrl(session.config, issue.key),
  snippet: snippet.slice(0, 300),
  read,
});

/** What an approval card says the call is about. */
const headline = (issue: JiraIssue) => `${issue.key} · ${issue.fields.summary ?? ""}`;

const loadIssue = (session: IntegrationSession, key: string) =>
  jiraCall<JiraIssue>(
    session,
    "GET",
    jiraPath(`/issue/${encodeURIComponent(key)}`, { fields: "summary,status,assignee,project" }),
  );

/**
 * One person who may be assigned, by name or email; “me” and “none” are
 * words, not people. Several matches are listed for the model to pick from
 * unless exactly one has the name or address as given.
 */
const assignee = (
  session: IntegrationSession,
  query: string,
  scope: { issueKey: string } | { project: string },
) =>
  Effect.gen(function* () {
    if (same(query, "none")) return { accountId: null, name: "nobody" };
    if (same(query, "me")) {
      const me = yield* jiraCall<JiraUser>(session, "GET", "/myself");
      return { accountId: me.accountId, name: who(me) ?? "you" };
    }
    const found = yield* jiraCall<JiraUser[]>(
      session,
      "GET",
      jiraPath("/user/assignable/search", { query, maxResults: 20, ...scope }),
    );
    const people = found.filter((user) => user.active !== false);
    const exact = people.filter(
      (user) =>
        (user.displayName && same(user.displayName, query)) ||
        (user.emailAddress && same(user.emailAddress, query)),
    );
    const match = people.length === 1 ? people[0] : exact.length === 1 ? exact[0] : undefined;
    if (match) return { accountId: match.accountId, name: who(match) ?? query };
    if (people.length === 0)
      return yield* reject(`Nobody who can be assigned here matches “${query}”.`);
    return yield* reject(
      `Several people match “${query}”: ${people
        .slice(0, 10)
        .map((user) => who(user))
        .join(", ")}. Pass the full name or email.`,
    );
  });

const handlers = integrationHandlers(JIRA_TOOLS)({
  search_issues: (session, args) =>
    Effect.gen(function* () {
      const jqlArg = text(args.jql);
      const words = text(args.text);
      if (jqlArg && words) return yield* reject("Pass either `jql` or `text`, not both.");
      const jql =
        jqlArg ??
        (words
          ? `text ~ ${jqlString(words)} ORDER BY updated DESC`
          : "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC");
      return ready(
        Effect.gen(function* () {
          const page = yield* jiraCall<{ issues: JiraIssue[]; nextPageToken?: string }>(
            session,
            "POST",
            "/search/jql",
            {
              jql,
              maxResults: SEARCH_RESULTS,
              fields: LIST_FIELDS,
              ...(text(args.pageToken) ? { nextPageToken: text(args.pageToken) } : {}),
            },
          );
          return {
            output: {
              jql,
              issues: page.issues.map(brief),
              nextPageToken: page.nextPageToken ?? null,
              ...(page.issues.length ? {} : { note: "No issues matched." }),
            },
            sources: page.issues.map((issue) =>
              source(
                session,
                issue,
                `${issue.fields.status?.name ?? ""} · ${issue.fields.summary ?? ""}`,
                false,
              ),
            ),
          };
        }),
      );
    }),

  read_issue: (session, args) =>
    Effect.gen(function* () {
      const key = yield* issueKey(args.key, "key");
      const offset = args.offset !== undefined && args.offset > 0 ? Math.floor(args.offset) : 0;
      const commentsFrom =
        args.commentsFrom !== undefined && args.commentsFrom > 0
          ? Math.floor(args.commentsFrom)
          : 0;
      return ready(
        Effect.gen(function* () {
          const path = `/issue/${encodeURIComponent(key)}`;
          const [issue, comments, transitions] = yield* Effect.all(
            [
              jiraCall<JiraIssue>(
                session,
                "GET",
                jiraPath(path, {
                  fields:
                    "summary,description,status,issuetype,priority,assignee,reporter,labels,created,updated,duedate,resolution,project,parent,subtasks,issuelinks",
                }),
              ),
              jiraCall<{ comments: JiraComment[]; total: number }>(
                session,
                "GET",
                jiraPath(`${path}/comment`, {
                  startAt: commentsFrom,
                  maxResults: COMMENTS_PER_READ,
                  orderBy: "created",
                }),
              ),
              jiraCall<{ transitions: Array<{ name: string; to?: { name?: string } }> }>(
                session,
                "GET",
                `${path}/transitions`,
              ),
            ],
            { concurrency: "unbounded" },
          );
          const description = adfToMarkdown(issue.fields.description);
          const end = Math.min(description.length, offset + INTEGRATION_LIMITS.readChars);
          const nextComment = commentsFrom + comments.comments.length;
          return {
            output: {
              ...brief(issue),
              url: issueUrl(session.config, issue.key),
              project: issue.fields.project?.key ?? null,
              reporter: who(issue.fields.reporter),
              labels: issue.fields.labels ?? [],
              created: issue.fields.created ?? null,
              due: issue.fields.duedate ?? null,
              resolution: issue.fields.resolution?.name ?? null,
              parent: issue.fields.parent ? linked(issue.fields.parent) : null,
              subtasks: (issue.fields.subtasks ?? []).map(linked),
              links: (issue.fields.issuelinks ?? []).map(linkLine).filter(Boolean),
              transitions: transitions.transitions.map((transition) =>
                transition.to?.name && transition.to.name !== transition.name
                  ? `${transition.name} (to ${transition.to.name})`
                  : transition.name,
              ),
              descriptionChars: description.length,
              offset,
              nextOffset: end < description.length ? end : null,
              description: description.slice(offset, end),
              comments: comments.comments.map((comment) => ({
                author: who(comment.author),
                created: comment.created ?? null,
                body: adfToMarkdown(comment.body),
              })),
              totalComments: comments.total,
              nextCommentsFrom: nextComment < comments.total ? nextComment : null,
            },
            sources: [source(session, issue, description, true)],
          };
        }),
      );
    }),

  list_projects: (session, args) =>
    Effect.succeed(
      ready(
        Effect.gen(function* () {
          const startAt =
            args.startAt !== undefined && args.startAt > 0 ? Math.floor(args.startAt) : 0;
          const page = yield* jiraCall<{
            values: Array<{
              key: string;
              name: string;
              issueTypes?: Array<{ name: string; subtask?: boolean }>;
            }>;
            isLast?: boolean;
          }>(
            session,
            "GET",
            jiraPath("/project/search", {
              query: text(args.query) ?? undefined,
              startAt,
              maxResults: INTEGRATION_LIMITS.listResults,
              expand: "issueTypes",
            }),
          );
          return {
            output: {
              projects: page.values.map((project) => ({
                key: project.key,
                name: project.name,
                issueTypes: (project.issueTypes ?? []).map((type) =>
                  type.subtask ? `${type.name} (subtask)` : type.name,
                ),
              })),
              nextStartAt: page.isLast === false ? startAt + page.values.length : null,
            },
          };
        }),
      ),
    ),

  create_issue: (session, args) =>
    Effect.gen(function* () {
      const project = text(args.project)?.toUpperCase();
      const type = text(args.type);
      const summary = text(args.summary);
      if (!project || !PROJECT_KEY.test(project))
        return yield* reject("Pass `project` as a project key such as PROJ.");
      if (!type) return yield* reject("Pass `type`, an issue type name such as Task.");
      if (!summary) return yield* reject("Pass `summary`.");
      const labels = yield* labelList(args.labels);
      const parent = args.parent === undefined ? null : yield* issueKey(args.parent, "parent");
      const query = text(args.assignee);
      // Resolved before approval, so the card names the person, not the guess.
      const person = query ? yield* assignee(session, query, { project }) : null;
      const priority = text(args.priority);
      return {
        summary: `${project} · “${summary}”${person ? ` → ${person.name}` : ""}`,
        reach: null,
        execute: jiraCall<{ key: string }>(session, "POST", "/issue", {
          fields: {
            project: { key: project },
            issuetype: { name: type },
            summary,
            ...(text(args.description) ? { description: markdownToAdf(args.description!) } : {}),
            ...(labels ? { labels } : {}),
            ...(priority ? { priority: { name: priority } } : {}),
            ...(parent ? { parent: { key: parent } } : {}),
            ...(person ? { assignee: { accountId: person.accountId } } : {}),
          },
        }).pipe(
          Effect.map((created) => {
            const url = issueUrl(session.config, created.key);
            return {
              output: { key: created.key, url, summary },
              link: { title: `${created.key}: ${summary}`, url },
            };
          }),
        ),
      };
    }),

  update_issue: (session, args) =>
    Effect.gen(function* () {
      const key = yield* issueKey(args.key, "key");
      const labels = yield* labelList(args.labels);
      const summary = text(args.summary);
      const priority = text(args.priority);
      const fields = {
        ...(summary ? { summary } : {}),
        ...(args.description !== undefined ? { description: markdownToAdf(args.description) } : {}),
        ...(labels ? { labels } : {}),
        ...(priority ? { priority: { name: priority } } : {}),
      };
      const changed = Object.keys(fields);
      if (changed.length === 0)
        return yield* reject(
          "Pass at least one of `summary`, `description`, `labels`, `priority`.",
        );
      const issue = yield* loadIssue(session, key);
      return {
        summary: `${headline(issue)}: ${changed.join(", ")}`,
        reach: null,
        execute: jiraCall<unknown>(session, "PUT", `/issue/${encodeURIComponent(key)}`, {
          fields,
        }).pipe(
          Effect.as({
            output: { key, updated: changed },
            link: { title: headline(issue), url: issueUrl(session.config, key) },
          }),
        ),
      };
    }),

  link_issues: (session, args) =>
    Effect.gen(function* () {
      const from = yield* issueKey(args.from, "from");
      const to = yield* issueKey(args.to, "to");
      const wording = text(args.type);
      if (!wording) return yield* reject("Pass `type`, such as blocks or relates to.");
      if (from === to) return yield* reject("An issue cannot be linked to itself.");
      const { issueLinkTypes } = yield* jiraCall<{
        issueLinkTypes: Array<{ name: string; inward: string; outward: string }>;
      }>(session, "GET", "/issueLinkType");
      const type = issueLinkTypes.find(
        (entry) => same(entry.name, wording) || same(entry.outward, wording),
      );
      const reversed = type ? null : issueLinkTypes.find((entry) => same(entry.inward, wording));
      const chosen = type ?? reversed;
      if (!chosen)
        return yield* reject(
          `Jira has no link “${wording}”. It has: ${issueLinkTypes
            .map((entry) => `${entry.outward} / ${entry.inward}`)
            .join(", ")}.`,
        );
      // The issue the outward wording describes: “A blocks B” has A.
      const [subject, object] = reversed ? [to, from] : [from, to];
      const [first, second] = yield* Effect.all(
        [loadIssue(session, from), loadIssue(session, to)],
        {
          concurrency: "unbounded",
        },
      );
      return {
        summary: `${first.key} ${reversed ? chosen.inward : chosen.outward} ${second.key} · ${
          first.fields.summary ?? ""
        }`,
        reach: null,
        // Jira's REST names run opposite to its wording: the issue sent as
        // `inwardIssue` is the one shown with the outward words.
        execute: jiraCall<unknown>(session, "POST", "/issueLink", {
          type: { name: chosen.name },
          inwardIssue: { key: subject },
          outwardIssue: { key: object },
        }).pipe(
          Effect.as({
            output: { linked: `${from} ${reversed ? chosen.inward : chosen.outward} ${to}` },
            link: { title: headline(first), url: issueUrl(session.config, from) },
          }),
        ),
      };
    }),

  add_comment: (session, args) =>
    Effect.gen(function* () {
      const key = yield* issueKey(args.key, "key");
      const body = text(args.body);
      if (!body) return yield* reject("Pass `body` with the comment.");
      const issue = yield* loadIssue(session, key);
      return {
        summary: headline(issue),
        reach: null,
        execute: jiraCall<{ id: string }>(
          session,
          "POST",
          `/issue/${encodeURIComponent(key)}/comment`,
          {
            body: markdownToAdf(body),
          },
        ).pipe(
          Effect.map((comment) => {
            const url = `${issueUrl(session.config, key)}?focusedCommentId=${encodeURIComponent(comment.id)}`;
            return {
              output: { key, commentId: comment.id, url },
              link: { title: headline(issue), url },
            };
          }),
        ),
      };
    }),

  assign_issue: (session, args) =>
    Effect.gen(function* () {
      const key = yield* issueKey(args.key, "key");
      const query = text(args.assignee);
      if (!query) return yield* reject("Pass `assignee`: a name or email, “me”, or “none”.");
      const issue = yield* loadIssue(session, key);
      const person = yield* assignee(session, query, { issueKey: key });
      return {
        summary: `${headline(issue)} → ${person.name}`,
        reach: null,
        execute: jiraCall<unknown>(session, "PUT", `/issue/${encodeURIComponent(key)}/assignee`, {
          accountId: person.accountId,
        }).pipe(
          Effect.as({
            output: { key, assignee: person.accountId ? person.name : null },
            link: { title: headline(issue), url: issueUrl(session.config, key) },
          }),
        ),
      };
    }),

  transition_issue: (session, args) =>
    Effect.gen(function* () {
      const key = yield* issueKey(args.key, "key");
      const target = text(args.to);
      if (!target) return yield* reject("Pass `to`, the status or transition name.");
      const path = `/issue/${encodeURIComponent(key)}`;
      const [issue, { transitions }] = yield* Effect.all(
        [
          loadIssue(session, key),
          jiraCall<{ transitions: Array<{ id: string; name: string; to?: { name?: string } }> }>(
            session,
            "GET",
            `${path}/transitions`,
          ),
        ],
        { concurrency: "unbounded" },
      );
      const byName = transitions.filter((entry) => same(entry.name, target));
      const byStatus = transitions.filter((entry) => entry.to?.name && same(entry.to.name, target));
      const chosen =
        byName.length === 1 ? byName[0] : byStatus.length === 1 ? byStatus[0] : undefined;
      if (!chosen)
        return yield* reject(
          transitions.length
            ? `${key} cannot move to “${target}” from ${issue.fields.status?.name ?? "its status"}. It can take: ${transitions
                .map((entry) => entry.name)
                .join(", ")}.`
            : `${key} has no transitions available to this account.`,
        );
      const comment = text(args.comment);
      const status = chosen.to?.name ?? chosen.name;
      return {
        summary: `${headline(issue)}: ${issue.fields.status?.name ?? "?"} → ${status}`,
        reach: null,
        // A comment is added on its own: the transition's screen may not take one.
        execute: jiraCall<unknown>(session, "POST", `${path}/transitions`, {
          transition: { id: chosen.id },
        }).pipe(
          Effect.andThen(
            comment
              ? jiraCall<unknown>(session, "POST", `${path}/comment`, {
                  body: markdownToAdf(comment),
                })
              : Effect.void,
          ),
          Effect.as({
            output: { key, status, ...(comment ? { commented: true } : {}) },
            link: { title: headline(issue), url: issueUrl(session.config, key) },
          }),
        ),
      };
    }),
});

const SITE = /^[a-z0-9][a-z0-9-]*\.atlassian\.net$/;

export const jiraAdapter: IntegrationAdapter = {
  id: "jira",
  normalizeConfig: (config) => {
    const raw = (config.site ?? "").trim().toLowerCase();
    const host = URL.canParse(/^https?:\/\//.test(raw) ? raw : `https://${raw}`)
      ? new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`).hostname
      : "";
    const site = host.includes(".") ? host : host && `${host}.atlassian.net`;
    if (!SITE.test(site))
      return { error: "Enter your Jira Cloud site, such as acme.atlassian.net." };
    return { config: { site: `https://${site}` }, fingerprint: site };
  },
  oauth: {
    // Atlassian needs to know the token is for its API, and asks each time so a
    // person can pick the site.
    authorizeUrl: () =>
      "https://auth.atlassian.com/authorize?audience=api.atlassian.com&prompt=consent",
    tokenUrl: () => "https://auth.atlassian.com/oauth/token",
    scopes: ["read:jira-work", "write:jira-work", "read:jira-user", "offline_access"],
  },
  verify: (session) =>
    jiraCall<JiraUser>(session, "GET", "/myself").pipe(
      Effect.map((me) => ({
        accountLabel: `${me.emailAddress || me.displayName || "Jira account"} · ${new URL(siteOf(session.config)).hostname}`,
      })),
    ),
  handlers,
  knowledge: null,
};
