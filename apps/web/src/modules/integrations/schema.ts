import { Schema } from "effect";

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
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
  /** False until first saved; access can only be managed once a row exists. */
  saved: boolean;
  enabled: boolean;
  config: Record<string, string>;
  oauthClientId: string | null;
  oauthSecretConfigured: boolean;
  allowApiKeys: boolean;
  audience: "private" | "instance";
  connectionCount: number;
}

export interface IntegrationConnectionView {
  id: string;
  authKind: "oauth" | "api_key";
  accountLabel: string;
  status: "active" | "needs_reauth";
  offerByDefault: boolean;
  /** Only tools set away from their default. */
  toolPermissions: Record<string, ToolPermission>;
  createdAt: string;
}

/** One integration as the signed-in person sees it in Settings and the composer. */
export interface UserIntegration {
  id: string;
  /** Enabled by an admin, configured, and shared with this person. */
  available: boolean;
  methods: { oauth: boolean; apiKey: boolean };
  apiKeyHelpUrl: string | null;
  connection: IntegrationConnectionView | null;
  /** What disconnecting would leave without credentials. */
  dependents: { sources: number; schedules: number };
}

export const IntegrationIdInput = Schema.Struct({ integrationId: IntegrationId });

export const SaveIntegrationConfigInput = Schema.Struct({
  integrationId: IntegrationId,
  enabled: Schema.Boolean,
  config: Schema.Record(Schema.String, Schema.String.check(Schema.isMaxLength(2_000))),
  oauthClientId: Schema.String.check(Schema.isMaxLength(500)),
  /** Absent keeps the stored secret; the form never round-trips it. */
  oauthClientSecret: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2_000))),
  allowApiKeys: Schema.Boolean,
});

export const ConnectApiKeyInput = Schema.Struct({
  integrationId: IntegrationId,
  apiKey: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_000)),
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
});

export const ConversationIntegrationInput = Schema.Struct({
  conversationId: Id,
  integrationId: IntegrationId,
  /** Null returns the chat to the connection's default. */
  enabled: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
});

export const ConversationIdInput = Schema.Struct({ conversationId: Id });

export const IntegrationDecision = Schema.Literals(["once", "conversation", "deny"]);
export type IntegrationDecision = typeof IntegrationDecision.Type;
export const DecideIntegrationCallInput = Schema.Struct({
  callId: Id,
  decision: IntegrationDecision,
});

export const SourceRule = Schema.Struct({
  nodeId: Id,
  title: Schema.String.check(Schema.isMaxLength(200)),
  mode: Schema.Literals(["include", "exclude"]),
});
export type SourceRule = typeof SourceRule.Type;

export const SourceRoot = Schema.Struct({
  nodeId: Id,
  title: Schema.String.check(Schema.isMaxLength(200)),
  mode: Schema.Literals(["all", "selected"]),
  rules: Schema.Array(SourceRule).check(Schema.isMaxLength(INTEGRATION_LIMITS.maxRules)),
});
export type SourceRoot = typeof SourceRoot.Type;

export const BrowseInput = Schema.Struct({
  integrationId: IntegrationId,
  parentId: Schema.optionalKey(Id),
});

export const SaveKnowledgeSourceInput = Schema.Struct({
  collectionId: Id,
  integrationId: IntegrationId,
  /** Absent adds a new source; present edits that one. */
  sourceId: Schema.optionalKey(Id),
  root: SourceRoot,
});

export const SourceIdInput = Schema.Struct({ sourceId: Id });

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
  callId: string;
  conversationId: string;
  messageId: string;
  integrationId: string;
  tool: string;
  /** The call's own: destructive when it would contact people. */
  access: "read" | "write" | "destructive";
  summary: string | null;
  /** Everyone the call would contact, exactly as it would send. */
  targets: ReadonlyArray<string>;
  expiresAt: number;
}
