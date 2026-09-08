import { sql, type SQL } from "drizzle-orm";
import {
  agents,
  agentUserGrants,
  agentGroupGrants,
  knowledgeCollections,
  knowledgeCollectionUserGrants,
  knowledgeCollectionGroupGrants,
  skills,
  skillUserGrants,
  skillGroupGrants,
} from "~/db/schema/index.ts";
import type { SharedResource } from "../schema.ts";

/** Exhaustive resource descriptors keep all resource families on the same sharing policy. */
export const sharingResources = {
  agent: {
    table: agents,
    userGrants: agentUserGrants,
    userResourceId: agentUserGrants.agentId,
    groupGrants: agentGroupGrants,
    groupResourceId: agentGroupGrants.agentId,
    available: sql`true`,
  },
  collection: {
    table: knowledgeCollections,
    userGrants: knowledgeCollectionUserGrants,
    userResourceId: knowledgeCollectionUserGrants.collectionId,
    groupGrants: knowledgeCollectionGroupGrants,
    groupResourceId: knowledgeCollectionGroupGrants.collectionId,
    available: sql`true`,
  },
  skill: {
    table: skills,
    userGrants: skillUserGrants,
    userResourceId: skillUserGrants.skillId,
    groupGrants: skillGroupGrants,
    groupResourceId: skillGroupGrants.skillId,
    available: sql`${skills.deletedAt} is null`,
  },
} satisfies Record<
  SharedResource["kind"],
  {
    table: unknown;
    userGrants: unknown;
    userResourceId: unknown;
    groupGrants: unknown;
    groupResourceId: unknown;
    available: SQL;
  }
>;
