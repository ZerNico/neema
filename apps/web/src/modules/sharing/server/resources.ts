import { eq, sql, type SQL } from "drizzle-orm";
import {
  agents,
  agentUserGrants,
  agentGroupGrants,
  customToolGroupGrants,
  customTools,
  customToolUserGrants,
  knowledgeCollections,
  knowledgeCollectionUserGrants,
  knowledgeCollectionGroupGrants,
  skills,
  skillUserGrants,
  skillGroupGrants,
  user,
} from "~/db/schema/index.ts";
import type { SharedResource } from "../schema.ts";

/**
 * Exhaustive resource descriptors keep all resource families on the same
 * sharing policy. `managedBy` says who may open the access dialog: the owning
 * user for personal resources, any admin for admin-authored custom tools.
 */
export const sharingResources = {
  agent: {
    table: agents,
    userGrants: agentUserGrants,
    userResourceId: agentUserGrants.agentId,
    groupGrants: agentGroupGrants,
    groupResourceId: agentGroupGrants.agentId,
    available: sql`true`,
    managedBy: (userId: string) => eq(agents.userId, userId),
  },
  collection: {
    table: knowledgeCollections,
    userGrants: knowledgeCollectionUserGrants,
    userResourceId: knowledgeCollectionUserGrants.collectionId,
    groupGrants: knowledgeCollectionGroupGrants,
    groupResourceId: knowledgeCollectionGroupGrants.collectionId,
    available: sql`true`,
    managedBy: (userId: string) => eq(knowledgeCollections.userId, userId),
  },
  skill: {
    table: skills,
    userGrants: skillUserGrants,
    userResourceId: skillUserGrants.skillId,
    groupGrants: skillGroupGrants,
    groupResourceId: skillGroupGrants.skillId,
    available: sql`${skills.deletedAt} is null`,
    managedBy: (userId: string) => eq(skills.userId, userId),
  },
  customTool: {
    table: customTools,
    userGrants: customToolUserGrants,
    userResourceId: customToolUserGrants.toolId,
    groupGrants: customToolGroupGrants,
    groupResourceId: customToolGroupGrants.toolId,
    available: sql`true`,
    managedBy: (userId: string) =>
      sql`exists(select 1 from ${user} where ${user.id} = ${userId} and ${user.role} = 'admin')`,
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
    managedBy: (userId: string) => SQL;
  }
>;
