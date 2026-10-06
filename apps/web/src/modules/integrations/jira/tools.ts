import { Schema } from "effect";
import { defineIntegrationTool } from "../manifest.ts";

const optionalText = (description: string) =>
  Schema.optionalKey(Schema.String.annotate({ description }));

const optionalNumber = (description: string) =>
  Schema.optionalKey(Schema.Number.annotate({ description }));

/**
 * Offered as a list of strings but decoding anything, so a model that sends
 * one string hears why from the handler instead of failing the answer.
 */
const stringList = (description: string) =>
  Schema.optionalKey(
    Schema.Any.check(
      Schema.makeFilter(() => true, {
        toJsonSchema: () => ({ type: "array", items: { type: "string" }, description }),
      }),
    ),
  );

const text = (value: string | undefined) => (value?.trim() ? value.trim() : null);
const quoted = (value: string | undefined) => {
  const found = text(value);
  return found ? `“${found.length > 80 ? `${found.slice(0, 79)}…` : found}”` : null;
};
const upper = (value: string | undefined) => text(value)?.toUpperCase() ?? null;

const KEY = "Issue key, such as PROJ-123.";

const searchIssuesTool = defineIntegrationTool({
  name: "search_issues",
  title: "Search issues",
  label: "Searched Jira",
  description:
    "Find issues by JQL or by words. Returns key, summary, status, type, assignee and last update, most recently updated first; read an issue for its description and comments. Without `jql` or `text`, lists the user's own open issues.",
  access: "read",
  parameters: Schema.Struct({
    jql: optionalText(
      'A JQL query, such as project = PROJ AND status = "In Progress" ORDER BY priority DESC.',
    ),
    text: optionalText("Words to find in summaries, descriptions and comments, instead of JQL."),
    pageToken: optionalText("`nextPageToken` from the previous answer, for more results."),
  }),
  summarize: (args) => quoted(args.jql) ?? quoted(args.text),
});

const readIssueTool = defineIntegrationTool({
  name: "read_issue",
  title: "Read issues",
  label: "Read a Jira issue",
  description:
    "Read one issue: its fields, description and comments as Markdown, links, subtasks and the transitions it can take next. Long descriptions and comment threads come back in parts; pass the offsets from the previous answer to continue.",
  access: "read",
  parameters: Schema.Struct({
    key: optionalText(KEY),
    offset: optionalNumber("Character offset in the description to continue from."),
    commentsFrom: optionalNumber("Index of the first comment to return."),
  }),
  summarize: (args) => upper(args.key),
});

const listProjectsTool = defineIntegrationTool({
  name: "list_projects",
  title: "List projects",
  label: "Listed Jira projects",
  description:
    "List the projects the user can see, with their keys and issue types, to know where an issue can be created.",
  access: "read",
  parameters: Schema.Struct({
    query: optionalText("Part of a project's name or key."),
    startAt: optionalNumber("`nextStartAt` from the previous answer, for more projects."),
  }),
  summarize: (args) => quoted(args.query),
});

const createIssueTool = defineIntegrationTool({
  name: "create_issue",
  title: "Create issues",
  label: "Created a Jira issue",
  description:
    "Create an issue. Needs `project` (key), `type` (an issue type name of that project, such as Task or Bug) and `summary`. `description` is Markdown. Pass `parent` to create a subtask or a child of an epic. If the project requires other fields, the answer names them.",
  access: "write",
  parameters: Schema.Struct({
    project: optionalText("Project key, such as PROJ."),
    type: optionalText("Issue type name, such as Task, Bug, Story or Sub-task."),
    summary: optionalText("One-line title."),
    description: optionalText("Markdown."),
    labels: stringList("Labels, without spaces."),
    priority: optionalText("Priority name, such as High."),
    parent: optionalText("Key of the parent issue or epic."),
    assignee: optionalText("Whom to assign: a name or email, or “me”."),
  }),
  summarize: (args) => quoted(args.summary),
});

const updateIssueTool = defineIntegrationTool({
  name: "update_issue",
  title: "Edit issues",
  label: "Edited a Jira issue",
  description:
    "Change an issue's summary, description (Markdown, replaces the old one), labels (replace the old ones) or priority. Pass only what changes. Status and assignee have their own tools.",
  access: "write",
  parameters: Schema.Struct({
    key: optionalText(KEY),
    summary: optionalText("New one-line title."),
    description: optionalText("New description, Markdown."),
    labels: stringList("The complete new set of labels."),
    priority: optionalText("Priority name, such as High."),
  }),
  summarize: (args) => upper(args.key),
});

const linkIssuesTool = defineIntegrationTool({
  name: "link_issues",
  title: "Link issues",
  label: "Linked Jira issues",
  description:
    "Link two issues so that `from` <type> `to`, where `type` is a link name or its wording as Jira shows it: “blocks”, “is blocked by”, “relates to”, “duplicates”.",
  access: "write",
  parameters: Schema.Struct({
    from: optionalText(KEY),
    type: optionalText("Link name or wording, such as blocks."),
    to: optionalText(KEY),
  }),
  summarize: (args) =>
    upper(args.from) && upper(args.to)
      ? `${upper(args.from)} ${text(args.type) ?? "→"} ${upper(args.to)}`
      : null,
});

const addCommentTool = defineIntegrationTool({
  name: "add_comment",
  title: "Comment on issues",
  label: "Commented in Jira",
  description: "Add a comment to an issue, as the user. `body` is Markdown.",
  access: "write",
  parameters: Schema.Struct({
    key: optionalText(KEY),
    body: optionalText("The comment, Markdown."),
  }),
  summarize: (args) => upper(args.key),
});

const assignIssueTool = defineIntegrationTool({
  name: "assign_issue",
  title: "Assign issues",
  label: "Assigned a Jira issue",
  description:
    "Assign an issue to someone who can be assigned in its project, by name or email; “me” for the user, “none” to unassign. When several people match, the answer lists them.",
  access: "write",
  parameters: Schema.Struct({
    key: optionalText(KEY),
    assignee: optionalText("A name or email, “me”, or “none”."),
  }),
  summarize: (args) =>
    upper(args.key) && text(args.assignee) ? `${upper(args.key)} → ${text(args.assignee)}` : null,
});

const transitionIssueTool = defineIntegrationTool({
  name: "transition_issue",
  title: "Move issues through the workflow",
  label: "Moved a Jira issue",
  description:
    "Move an issue to another status through its workflow, by the status or transition name (read_issue lists the ones available). Optionally add a comment with it.",
  access: "write",
  parameters: Schema.Struct({
    key: optionalText(KEY),
    to: optionalText("Target status or transition name, such as Done."),
    comment: optionalText("A comment to add, Markdown."),
  }),
  summarize: (args) =>
    upper(args.key) && text(args.to) ? `${upper(args.key)} → ${text(args.to)}` : null,
});

export const JIRA_TOOLS = [
  searchIssuesTool,
  readIssueTool,
  listProjectsTool,
  createIssueTool,
  updateIssueTool,
  linkIssuesTool,
  addCommentTool,
  assignIssueTool,
  transitionIssueTool,
] as const;
