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

/**
 * A saved chat configuration: instructions, a preferred model, tool defaults
 * and attached collections. Agents run on the ordinary generation path: what
 * is stored here is a set of *preferences*, never permissions.
 */

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
    /** Optimistic save concurrency and execution provenance. */
    configRevision: integer("config_revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("agents_user_id_idx").on(t.userId)],
);

/**
 * Attached collections. Sharing the agent does NOT share these: a recipient
 * needs their own read access to each collection, checked separately.
 */
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

/** Private agent contribution captured once for an execution attempt. */
export type ResolvedAgentConfig = {
  agentId: string;
  configRevision: number;
  name: string;
  icon: string;
  instructions: string;
  collectionIds: ReadonlyArray<string>;
  skillIds?: ReadonlyArray<string>;
  searchEnabled: boolean;
  planEnabled: boolean;
};

/**
 * Fixed live association. No row means plain chat; a null FK is a deletion
 * tombstone that blocks new attempts without hiding historical messages.
 */
export const conversationAgents = pgTable("conversation_agents", {
  conversationId: text("conversation_id")
    .primaryKey()
    .references(() => conversations.id, { onDelete: "cascade" }),
  agentId: text("agent_id").references(() => agents.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The target is an identity snapshot, not a foreign key: deleting an agent must
 * never turn the next save into creation, or erase an accepted save receipt.
 */
export const conversationAgentDrafts = pgTable(
  "conversation_agent_drafts",
  {
    id: text().primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    settings: jsonb().$type<import("~/modules/agents/draft-schema.ts").DraftSettings>().notNull(),
    revision: integer().notNull().default(1),
    targetAgentId: text("target_agent_id"),
    targetRevision: integer("target_revision"),
    savedDraftRevision: integer("saved_draft_revision"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("conversation_agent_drafts_conversation_idx").on(t.conversationId)],
);

/**
 * Private execution record for one attempt, never a source of future agent
 * settings. Retries replace it atomically; branches copy historical records.
 */
export const messageGenerationConfig = pgTable("message_generation_config", {
  messageId: text("message_id")
    .primaryKey()
    .references(() => messages.id, { onDelete: "cascade" }),
  agentId: text("agent_id").references(() => agents.id, { onDelete: "set null" }),
  resolvedAgent: jsonb("resolved_agent").$type<ResolvedAgentConfig>(),
  /** Original standalone inputs, including overlaps with agent dependencies. */
  standaloneCollectionIds: jsonb("standalone_collection_ids")
    .$type<string[]>()
    .notNull()
    .default([]),
  standaloneSkillIds: jsonb("standalone_skill_ids").$type<string[]>().notNull().default([]),
  skills: jsonb("skills")
    .$type<import("~/modules/skills/schema.ts").SkillManifestEntry[]>()
    .notNull()
    .default([]),
  /** How this generation was allowed to reach its knowledge. */
  knowledgeMode: text("knowledge_mode", { enum: ["none", "context", "retrieval"] })
    .notNull()
    .default("none"),
  planEnabled: boolean("plan_enabled").notNull().default(false),
  /**
   * The effective settings this generation ran with, not the agent's
   * preferences: an agent that asks for search cannot enable it for a model or
   * an instance that does not allow it, and the composer can override either
   * way. A retry preserves the explicit choice, not new agent defaults.
   */
  searchEnabled: boolean("search_enabled").notNull().default(false),
  /** Whether `deep_research` was offered to this attempt. The model still chooses. */
  researchEnabled: boolean("research_enabled").notNull().default(false),
  /**
   * The folders attached on the machine this attempt was sent from, by name.
   * Null means the tools that reach a machine were not offered. Only names:
   * the paths stay on the machine that granted them, so the same conversation
   * continued elsewhere resolves its own folders or none.
   */
  desktopFolders: text("desktop_folders").array(),
  /** Whether that machine could sandbox a command when this was sent. */
  desktopCommands: boolean("desktop_commands").notNull().default(false),
  /**
   * The effective union of agent dependencies and standalone inputs, in order. Kept beside the resolved
   * document manifest because an empty or fully-pending collection resolves to
   * no version rows at all, and "nothing selected" must not be confused with
   * "a selection that happens to be empty", since authorization checks the
   * collections themselves.
   */
  collectionIds: jsonb("collection_ids").$type<string[]>().notNull().default([]),
});
