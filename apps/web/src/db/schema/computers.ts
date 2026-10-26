import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";
import { user } from "./auth.ts";
import { conversations } from "./chat.ts";

/**
 * A desktop install a person signed in on, which runs their chats' computers. The id is the
 * install's own (`machine.json`); keyed with the person, since the same install may be signed
 * in by someone else later. See docs/internals/desktop.md.
 */
export const machines = pgTable(
  "machines",
  {
    id: text().notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** What the machine calls itself, refreshed on every connect. */
    name: text().notNull(),
    /** The person's own name for it, shown in place of `name` when set. */
    label: text(),
    platform: text({ enum: ["darwin", "win32", "linux"] }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.id] })],
);

/**
 * A network destination commands may reach: for one chat, or for every chat of the person
 * when `conversationId` is null. The machine's egress proxy decides with these.
 */
export const networkGrants = pgTable(
  "network_grants",
  {
    id: text()
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id").references(() => conversations.id, {
      onDelete: "cascade",
    }),
    host: text().notNull(),
    port: integer().notNull(),
    // Lets this name reach a private-network address; set only when the person approved one.
    privateNetwork: boolean("private_network").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // An every-chat grant has no conversation; it is still one per destination.
    unique("network_grants_destination_key")
      .on(t.userId, t.conversationId, t.host, t.port)
      .nullsNotDistinct(),
    index("network_grants_conversation_idx")
      .on(t.conversationId)
      .where(sql`${t.conversationId} is not null`),
  ],
);
