import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { conversations, messages } from "./chat.ts";
import { groups } from "./groups.ts";

// A saved chat configuration — instructions, a preferred model, tool defaults
// and attached collections. Agents run on the ordinary generation path: what
// is stored here is a set of *preferences*, never permissions.

export const agents = pgTable(
  "agents",
  {
    id: text().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text().notNull(),
    description: text().notNull().default(""),
    /** Icon identifier from a fixed app-side set; never a URL. */
    icon: text().notNull().default("robot"),
    instructions: text().notNull().default(""),
    // Preferred model. A recipient who cannot use it picks their own; nothing
    // here bypasses model access rules.
    // Retain the selection when a model is deleted, so use fails explicitly
    // rather than silently changing the agent's preferred configuration.
    modelId: text("model_id"),
    searchEnabled: boolean("search_enabled").notNull().default(false),
    planEnabled: boolean("plan_enabled").notNull().default(false),
    starters: jsonb().$type<string[]>().notNull().default([]),
    audience: text({ enum: ["private", "instance"] })
      .notNull()
      .default("private"),
    /** Bumped on edits; existing conversations keep their installed revision. */
    configRevision: integer("config_revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("agents_user_id_idx").on(t.userId)],
);

// Attached collections. Sharing the agent does NOT share these: a recipient
// needs their own read access to each collection, checked separately.
export const agentCollections = pgTable(
  "agent_collections",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    // Saved dependency ids survive deletion; reads join against current ACLs.
    collectionId: text("collection_id").notNull(),
    position: integer().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.agentId, t.collectionId] }),
    index("agent_collections_collection_idx").on(t.collectionId),
  ],
);

export const agentUserGrants = pgTable(
  "agent_user_grants",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.agentId, t.userId] }),
    index("agent_user_grants_user_idx").on(t.userId),
  ],
);

export const agentGroupGrants = pgTable(
  "agent_group_grants",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.agentId, t.groupId] }),
    index("agent_group_grants_group_idx").on(t.groupId),
  ],
);

/** What the agent contributed, frozen at selection time. */
export type AgentConfigSnapshot = {
  agentId: string;
  configRevision: number;
  name: string;
  icon: string;
  instructions: string;
  collectionIds: ReadonlyArray<string>;
  searchEnabled: boolean;
  planEnabled: boolean;
};

// Conversation defaults: which agent is installed and what it contributed.
// Absent for an ordinary chat, which behaves exactly as before.
export const conversationAgents = pgTable("conversation_agents", {
  conversationId: text("conversation_id")
    .primaryKey()
    .references(() => conversations.id, { onDelete: "cascade" }),
  agentId: text("agent_id").references(() => agents.id, { onDelete: "set null" }),
  snapshot: jsonb().$type<AgentConfigSnapshot>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The effective configuration one assistant generation ran with. Retry reuses
 * this row rather than re-resolving, so a reply cannot change character because
 * the agent was edited in between; branching copies it.
 */
export const messageGenerationConfig = pgTable("message_generation_config", {
  messageId: text("message_id")
    .primaryKey()
    .references(() => messages.id, { onDelete: "cascade" }),
  agentId: text("agent_id").references(() => agents.id, { onDelete: "set null" }),
  snapshot: jsonb().$type<AgentConfigSnapshot>(),
  /** How this generation was allowed to reach its knowledge. */
  knowledgeMode: text("knowledge_mode", { enum: ["none", "context", "retrieval"] })
    .notNull()
    .default("none"),
  planEnabled: boolean("plan_enabled").notNull().default(false),
  /**
   * The effective settings this generation ran with, not the agent's
   * preferences: an agent that asks for search cannot enable it for a model or
   * an instance that does not allow it, and the composer can override either
   * way. Retry reuses what actually ran.
   */
  searchEnabled: boolean("search_enabled").notNull().default(false),
  /**
   * The collections that were selected, in order. Kept beside the resolved
   * document manifest because an empty or fully-pending collection resolves to
   * no version rows at all, and "nothing selected" must not be confused with
   * "a selection that happens to be empty" — authorization checks the
   * collections themselves.
   */
  collectionIds: jsonb("collection_ids").$type<string[]>().notNull().default([]),
});
