import { Schema } from "effect";
import type { IntegrationToolInfo } from "./manifest.ts";
import type { McpToolEntry } from "./mcp/catalog.ts";
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
  enabled: boolean;
  config: Record<string, string>;
  oauthClientId: string | null;
  oauthSecretConfigured: boolean;
  allowApiKeys: boolean;
  audience: "private" | "instance";
  connectionCount: number;
  sharedCredentialConfigured: boolean;
  /** For a type whose tools come from its server: what was approved and what it lists now. */
  catalog: AdminCatalog | null;
}

/** A catalog type's tools as the admin reviews them. */
export interface AdminCatalog {
  approved: ReadonlyArray<McpToolEntry>;
  latest: ReadonlyArray<McpToolEntry> | null;
  server: Readonly<Record<string, string>> | null;
  checkedAt: string | null;
  checkError: string | null;
  reviewedAt: string | null;
  /** Names `latest`; an approval sends it back. */
  version: string | null;
}

export interface IntegrationConnectionView {
  id: string;
  authKind: "oauth" | "api_key" | "none" | "shared";
  accountLabel: string;
  status: "active" | "needs_reauth";
  offerByDefault: boolean;
  /** Only tools set away from their default. */
  toolPermissions: Record<string, ToolPermission>;
  /** The manifest scope's items it is limited to; null is everything. */
  scope: string[] | null;
  /** OAuth scopes a call was refused for; signing in again grants them. */
  requiredScopes: string[] | null;
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
  /** Enabled by an admin, configured, and shared with this person. */
  available: boolean;
  /** Added by this person for themselves, so they set it up and review its tools. */
  personal: boolean;
  /** `everyone`: the open way is on for everyone without a press, so it cannot be disconnected. */
  methods: {
    oauth: boolean;
    apiKey: boolean;
    open: "none" | "shared" | null;
    everyone: boolean;
  };
  /** What chats can be offered, in order, before any per-person permission. */
  tools: ReadonlyArray<IntegrationToolInfo>;
  apiKeyHelpUrl: string | null;
  connection: IntegrationConnectionView | null;
  /** What disconnecting would leave without credentials. */
  dependents: { sources: number; schedules: number };
}

export const IntegrationIdInput = Schema.Struct({ integrationId: IntegrationId });

/** A public MCP server one person added for themselves; only they use and review it. */
export interface PersonalServer {
  id: string;
  name: string;
  /** The MCP admin fields a person may set: address, way in, header. */
  config: Record<string, string>;
  catalog: AdminCatalog;
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
});

/** One integration as anyone may see it: enough to name and draw a stored reference. */
export interface IntegrationDirectoryEntry {
  id: string;
  kind: string;
  name: string;
}

export const SaveIntegrationConfigInput = Schema.Struct({
  integrationId: IntegrationId,
  name: Schema.String.check(Schema.isMaxLength(100)),
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

export const ApproveCatalogInput = Schema.Struct({
  integrationId: IntegrationId,
  /** The listing the admin looked at; a newer one since is refused, not approved unseen. */
  version: Schema.String.check(Schema.isMaxLength(200)),
  decisions: Schema.Array(
    Schema.Struct({
      mcpName: Schema.String.check(Schema.isMaxLength(200)),
      enabled: Schema.Boolean,
      access: ToolAccessInput,
    }),
  ).check(Schema.isMaxLength(500)),
});

export const ConnectApiKeyInput = Schema.Struct({
  integrationId: IntegrationId,
  /** The manifest's API key fields by key; the service checks them against it. */
  values: Schema.Record(Schema.String, Schema.String.check(Schema.isMaxLength(2_000))).check(
    Schema.isMaxProperties(10),
  ),
});

export const ToolPermission = Schema.Literals(["allow", "ask", "block"]);
export type ToolPermission = typeof ToolPermission.Type;

export const UpdateConnectionInput = Schema.Struct({
  integrationId: IntegrationId,
  offerByDefault: Schema.optionalKey(Schema.Boolean),
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
  integrationId: IntegrationId,
  /** Null returns the chat to the connection's default. */
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
  integrationId: IntegrationId,
  parentId: Schema.optionalKey(EntityId),
});

export const SaveKnowledgeSourceInput = Schema.Struct({
  collectionId: EntityId,
  integrationId: IntegrationId,
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
export const approvalConsequence = (call: PendingIntegrationCall, service: string) =>
  call.targets.length > 0
    ? `This will contact ${call.targets.length === 1 ? "this person" : `these ${call.targets.length} people`} from your ${service} account.`
    : `This will ${call.access === "read" ? "read" : call.access === "write" ? "change" : "delete"} with your ${service} account.`;
