import { Schema } from "effect";
import type { IntegrationToolInfo, ToolAccess } from "./manifest.ts";
import { EntityId } from "~/entity-id.ts";

const IntegrationId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,31}$/));

export const INTEGRATION_LIMITS = {
  /** Characters of one document handed to the model per read. */
  readChars: 24_000,
  searchResults: 10,
  listResults: 50,
  /** Page choices under one root. */
  maxRules: 200,
  /** Characters of one tool result preview kept on the row. */
  previewChars: 1_000,
} as const;

export interface AdminIntegration {
  id: string;
  /** The shipped type it runs on. */
  kind: string;
  name: string;
  /** What it offers in the admin's words, or null for the type's own. */
  description: string | null;
  /** The known MCP server it points at, for its logo and setup note. */
  server: string | null;
  enabled: boolean;
  config: Record<string, string>;
  oauthClientId: string | null;
  oauthSecretConfigured: boolean;
  allowApiKeys: boolean;
  audience: "private" | "instance";
  connectionCount: number;
  sharedCredentialConfigured: boolean;
  /** Every tool any account sees, with the admin's word on each. */
  tools: ReadonlyArray<AdminTool>;
  /** For a type whose tools its server lists: how the checks behind `tools` went. */
  listings: ListingSummary | null;
}

/** Every account's listing of one server, in short. */
export interface ListingSummary {
  /** The newest check that ran, worked or not. */
  checkedAt: string | null;
  /** Accounts whose last check failed. */
  failing: number;
  /** What one of them said. */
  error: string | null;
}

/** One tool as the admin manages it, by the name the setting is kept under. */
export interface AdminTool {
  /** The server's or the manifest's name. */
  name: string;
  title: string;
  description: string;
  /** What it does as offered: the admin's correction, else what it claims. */
  access: ToolAccess;
  /** What it claims, or the manifest says. */
  claimed: ToolAccess;
  off: boolean;
  /** Why it can never be offered as the server describes it. */
  unsupported: string | null;
  /** On, but past the most a chat is offered, so no chat gets it. */
  pastLimit: boolean;
}

/** One check of what a server lists: to an account, or without one. */
export interface ToolListingView {
  server: Readonly<Record<string, string>> | null;
  checkedAt: string | null;
  checkError: string | null;
  /** Null before a check worked. */
  count: number | null;
}

/**
 * Ways in that hold nothing of the person's: open, or the admin's shared key.
 * A person has at most one such connection per integration.
 */
export const NO_ACCOUNT_KINDS = ["none", "shared"] as const;
export const usesNoAccount = (kind: IntegrationConnectionView["authKind"]) =>
  NO_ACCOUNT_KINDS.some((entry) => entry === kind);

/** What a person calls an account: their own name for it, else what the service reports. */
export const accountName = (connection: { name: string | null; accountLabel: string }) =>
  connection.name ?? connection.accountLabel;

/** One account of a person on an integration. */
export interface IntegrationConnectionView {
  id: string;
  authKind: "oauth" | "api_key" | "none" | "shared";
  accountLabel: string;
  /** The person's own name for it; null shows the account label. */
  name: string | null;
  status: "active" | "needs_reauth";
  offerByDefault: boolean;
  /** Only tools set away from their default. */
  toolPermissions: Record<string, ToolPermission>;
  /** The manifest scope's items it is limited to; null is everything. */
  scope: string[] | null;
  /** OAuth scopes a call was refused for; signing in again grants them. */
  requiredScopes: string[] | null;
  /** For a type whose tools its server lists: the last check for this account. */
  listing: ToolListingView | null;
  /** What chats can be offered with this account, in order, before its permissions. */
  tools: ReadonlyArray<IntegrationToolInfo>;
  /** What disconnecting it would leave without credentials. */
  dependents: { sources: number; schedules: number };
  createdAt: string;
}

/** One item a connection can be limited to; `detail` is a short handle shown beside it. */
export interface ScopeOption {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
}

/** One integration as the signed-in person sees it in Settings and the composer. */
export interface UserIntegration {
  id: string;
  kind: string;
  name: string;
  /** The admin's own words for what it offers, over the type's. */
  description: string | null;
  /** The known MCP server it points at, for its logo and description. */
  server: string | null;
  /** Enabled by an admin, configured, and shared with this person. */
  available: boolean;
  /** Added by this person for themselves, so they set it up. */
  personal: boolean;
  /** `everyone`: the open way is on for everyone without a press, so it cannot be disconnected. */
  methods: {
    oauth: boolean;
    apiKey: boolean;
    open: "none" | "shared" | null;
    everyone: boolean;
  };
  /**
   * What chats can be offered before connecting: a shipped type's tools, or
   * what the server lists without an account. Each account has its own.
   */
  tools: ReadonlyArray<IntegrationToolInfo>;
  apiKeyHelpUrl: string | null;
  /** This person's accounts on it, oldest first; empty when not connected. */
  connections: ReadonlyArray<IntegrationConnectionView>;
}

export const IntegrationIdInput = Schema.Struct({ integrationId: IntegrationId });

export const ProbeServerInput = Schema.Struct({
  url: Schema.String.check(Schema.isMaxLength(2_000)),
});

export const ConnectionIdInput = Schema.Struct({ connectionId: EntityId });

/** A public MCP server one person added for themselves; only they use it. */
export interface PersonalServer {
  id: string;
  name: string;
  /** The MCP admin fields a person may set: address, way in, header. */
  config: Record<string, string>;
  /** The last check of what it lists, to their account or without one. */
  listing: ToolListingView | null;
}

export interface PersonalServers {
  /** Whether this person may add servers; ones added before stop working without it. */
  canAdd: boolean;
  servers: ReadonlyArray<PersonalServer>;
}

/** The fields of the MCP setup a person fills in for their own server; sign-in asks the server for scopes. */
export const PERSONAL_SERVER_FIELDS = ["url", "ways", "header"] as const;

export const SavePersonalServerInput = Schema.Struct({
  /** Null adds a server. */
  integrationId: Schema.NullOr(IntegrationId),
  name: Schema.String.check(Schema.isMaxLength(100)),
  config: Schema.Record(Schema.String, Schema.String.check(Schema.isMaxLength(2_000))).check(
    Schema.isMaxProperties(10),
  ),
});

/** The service checks the id's stricter shape and that the type ships. */
export const CreateIntegrationInput = Schema.Struct({
  kind: IntegrationId,
  name: Schema.String.check(Schema.isMaxLength(100)),
  /** A known MCP server, whose address and sign-in come with it. */
  server: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(40))),
});

/** One integration as anyone may see it: enough to name and draw a stored reference. */
export interface IntegrationDirectoryEntry {
  id: string;
  kind: string;
  name: string;
  /** The admin's own words for what it offers, over the type's. */
  description: string | null;
  /** The known MCP server it points at, for its logo. */
  server: string | null;
}

export const SaveIntegrationConfigInput = Schema.Struct({
  integrationId: IntegrationId,
  name: Schema.String.check(Schema.isMaxLength(100)),
  description: Schema.String.check(Schema.isMaxLength(400)),
  enabled: Schema.Boolean,
  config: Schema.Record(Schema.String, Schema.String.check(Schema.isMaxLength(2_000))),
  oauthClientId: Schema.String.check(Schema.isMaxLength(500)),
  /** Absent keeps the stored secret; the form never round-trips it. */
  oauthClientSecret: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2_000))),
  allowApiKeys: Schema.Boolean,
  /** The shared credential's fields; absent keeps it, null clears it. */
  sharedCredential: Schema.optionalKey(
    Schema.NullOr(
      Schema.Record(Schema.String, Schema.String.check(Schema.isMaxLength(4_000))).check(
        Schema.isMaxProperties(10),
      ),
    ),
  ),
});

export const ToolAccessInput = Schema.Literals(["read", "write", "destructive"]);

/** The admin's word on one tool: null clears it back to what the tool claims. */
export const SetToolInput = Schema.Struct({
  integrationId: IntegrationId,
  tool: Schema.String.check(Schema.isMaxLength(200)),
  off: Schema.Boolean,
  access: Schema.NullOr(ToolAccessInput),
});

export const SetOwnToolAccessInput = Schema.Struct({
  integrationId: IntegrationId,
  tool: Schema.String.check(Schema.isMaxLength(200)),
  access: ToolAccessInput,
});

export const ConnectApiKeyInput = Schema.Struct({
  integrationId: IntegrationId,
  /** Replaces this account's key; absent adds an account. */
  connectionId: Schema.optionalKey(EntityId),
  /** The manifest's API key fields by key; the service checks them against it. */
  values: Schema.Record(Schema.String, Schema.String.check(Schema.isMaxLength(2_000))).check(
    Schema.isMaxProperties(10),
  ),
});

export const ToolPermission = Schema.Literals(["allow", "ask", "block"]);
export type ToolPermission = typeof ToolPermission.Type;

export const UpdateConnectionInput = Schema.Struct({
  connectionId: EntityId,
  offerByDefault: Schema.optionalKey(Schema.Boolean),
  /** Null goes back to what the service reports. */
  name: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(60)))),
  /** Merged into what is stored; one tool or a whole group at a time. */
  toolPermissions: Schema.optionalKey(
    Schema.Record(Schema.String.check(Schema.isMaxLength(64)), ToolPermission),
  ),
  /** The whole new limit; null lifts it. */
  scope: Schema.optionalKey(
    Schema.NullOr(
      Schema.Array(Schema.String.check(Schema.isMaxLength(100))).check(Schema.isMaxLength(200)),
    ),
  ),
});

export const ConversationIntegrationInput = Schema.Struct({
  conversationId: EntityId,
  connectionId: EntityId,
  /** Null returns the chat to the account's default. */
  enabled: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
});

export const ConversationIdInput = Schema.Struct({ conversationId: EntityId });

export const IntegrationDecision = Schema.Literals(["once", "conversation", "deny"]);
export type IntegrationDecision = typeof IntegrationDecision.Type;
export const DecideIntegrationCallInput = Schema.Struct({
  callId: EntityId,
  decision: IntegrationDecision,
});

const ElicitationValue = Schema.Union([
  Schema.String.check(Schema.isMaxLength(4_000)),
  Schema.Number,
  Schema.Boolean,
  Schema.Array(Schema.String.check(Schema.isMaxLength(500))).check(Schema.isMaxLength(50)),
]);
export type ElicitationValue = typeof ElicitationValue.Type;

export const AnswerElicitationInput = Schema.Struct({
  callId: EntityId,
  /** The question answered, so a tab still showing an earlier one cannot answer the next. */
  promptId: EntityId,
  action: Schema.Literals(["accept", "decline", "cancel"]),
  values: Schema.optionalKey(
    Schema.Record(Schema.String.check(Schema.isMaxLength(100)), ElicitationValue).check(
      Schema.isMaxProperties(30),
    ),
  ),
});

/** One input of a form a service asks the person to fill in mid-call. */
export interface ElicitationField {
  key: string;
  label: string;
  description: string | null;
  kind:
    | "text"
    | "email"
    | "url"
    | "date"
    | "datetime"
    | "number"
    | "integer"
    | "boolean"
    | "choice"
    | "choices";
  required: boolean;
  options?: ReadonlyArray<{ value: string; label: string }>;
  default?: ElicitationValue;
  min?: number;
  max?: number;
}

/** What a service asks for mid-call: a form, or a page to visit first. */
export type ElicitationPrompt =
  | { mode: "form"; message: string; fields: ReadonlyArray<ElicitationField> }
  | { mode: "url"; message: string; url: string };

export type ElicitationAnswer =
  | { action: "accept"; values?: Readonly<Record<string, ElicitationValue>> }
  | { action: "decline" }
  | { action: "cancel" };

export const SourceRule = Schema.Struct({
  nodeId: EntityId,
  title: Schema.String.check(Schema.isMaxLength(200)),
  mode: Schema.Literals(["include", "exclude"]),
});
export type SourceRule = typeof SourceRule.Type;

export const SourceRoot = Schema.Struct({
  nodeId: EntityId,
  title: Schema.String.check(Schema.isMaxLength(200)),
  mode: Schema.Literals(["all", "selected"]),
  rules: Schema.Array(SourceRule).check(Schema.isMaxLength(INTEGRATION_LIMITS.maxRules)),
});
export type SourceRoot = typeof SourceRoot.Type;

export const BrowseInput = Schema.Struct({
  connectionId: EntityId,
  parentId: Schema.optionalKey(EntityId),
});

export const SaveKnowledgeSourceInput = Schema.Struct({
  collectionId: EntityId,
  /** The owner's account the sync runs as. */
  connectionId: EntityId,
  /** Absent adds a new source; present edits that one. */
  sourceId: Schema.optionalKey(EntityId),
  root: SourceRoot,
});

export const SourceIdInput = Schema.Struct({ sourceId: EntityId });

/** One node of an integration's tree, as the source picker lists it. */
export interface BrowseNode {
  id: string;
  title: string;
  kind: "container" | "document";
  hasChildren: boolean;
}

export interface KnowledgeSourceView {
  id: string;
  /** The collection owner: only they can edit, sync or remove it. */
  canEdit: boolean;
  collectionId: string;
  integrationId: string;
  /** The account it syncs as; null once that account was disconnected. */
  connectionId: string | null;
  /** That account's name, for the owner choosing between several. */
  account: string | null;
  root: SourceRoot;
  status: "idle" | "syncing" | "error";
  lastError: string | null;
  lastSyncedAt: string | null;
  stats: { synced: number; tooLarge: number; overLimit: number; elsewhere?: number } | null;
  /** False once the owner's connection is gone or needs reauth. */
  connected: boolean;
}

/** A waiting integration call, as the approval card and toasts show it. */
export interface PendingIntegrationCall {
  /** An approval before the call runs, or a service's question while it runs. */
  kind: "approval" | "elicitation";
  callId: string;
  conversationId: string;
  messageId: string;
  integrationId: string;
  /** Which of the person's accounts acts, and what they call it; null without an account. */
  connectionId: string;
  account: string | null;
  tool: string;
  /** The tool as the person knows it, as the activity row names it. */
  label: string;
  /** The call's own: destructive when it would contact people. */
  access: "read" | "write" | "destructive";
  summary: string | null;
  /** Everyone the call would contact, exactly as it would send. */
  targets: ReadonlyArray<string>;
  /** Every argument, when the summary cannot say what the call sends. */
  details?: ReadonlyArray<{ key: string; value: string }>;
  /** Everything the call sends, when `details` had to shorten or leave something out. */
  inFull?: string;
  prompt?: ElicitationPrompt;
  /** Which entry this is: one call may ask several questions, one after another. */
  promptId: string;
  expiresAt: number;
}

/** What deciding a call would do, in the words the card and a connected app both show. */
export const approvalConsequence = (call: PendingIntegrationCall, service: string) => {
  const account = `your ${service} account${call.account ? ` “${call.account}”` : ""}`;
  return call.targets.length > 0
    ? `This will contact ${call.targets.length === 1 ? "this person" : `these ${call.targets.length} people`} from ${account}.`
    : `This will ${call.access === "read" ? "read" : call.access === "write" ? "change" : "delete"} with ${account}.`;
};
