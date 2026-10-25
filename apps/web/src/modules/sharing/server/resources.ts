import { eq, sql, type SQL } from "drizzle-orm";
import type { Capability } from "~/modules/groups/policy.ts";
import { capabilityAllowedSql } from "~/modules/groups/server/policy.ts";
import {
  agents,
  agentUserGrants,
  agentGroupGrants,
  customToolGroupGrants,
  customTools,
  customToolUserGrants,
  integrationConfigs,
  integrationGroupGrants,
  integrationUserGrants,
  knowledgeCollections,
  knowledgeCollectionUserGrants,
  knowledgeCollectionGroupGrants,
  skills,
  skillUserGrants,
  skillGroupGrants,
  groupMembers,
  user,
} from "~/db/schema/index.ts";
import type { SharedResource } from "../schema.ts";

/**
 * Exhaustive resource descriptors keep all resource families on the same
 * sharing policy. `managedBy` says who may open the access dialog: the owning
 * user for personal resources, any admin for admin-authored custom tools.
 * A personal kind also names its owner and audience columns, the capability
 * to use it and the one its owner needs to keep it shared, and the group
 * member right that lets a member share it; `readableBy` is built from these.
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
    personal: {
      id: agents.id,
      owner: agents.userId,
      audience: agents.audience,
      userGrantUser: agentUserGrants.userId,
      groupGrantGroup: agentGroupGrants.groupId,
      use: "agentsUse" as const,
      create: "agentsCreate" as const,
      shareRight: groupMembers.shareAgents,
    },
  },
  collection: {
    table: knowledgeCollections,
    userGrants: knowledgeCollectionUserGrants,
    userResourceId: knowledgeCollectionUserGrants.collectionId,
    groupGrants: knowledgeCollectionGroupGrants,
    groupResourceId: knowledgeCollectionGroupGrants.collectionId,
    available: sql`true`,
    managedBy: (userId: string) => eq(knowledgeCollections.userId, userId),
    personal: {
      id: knowledgeCollections.id,
      owner: knowledgeCollections.userId,
      audience: knowledgeCollections.audience,
      userGrantUser: knowledgeCollectionUserGrants.userId,
      groupGrantGroup: knowledgeCollectionGroupGrants.groupId,
      use: "knowledgeUse" as const,
      create: "knowledgeCreate" as const,
      shareRight: groupMembers.shareKnowledge,
    },
  },
  skill: {
    table: skills,
    userGrants: skillUserGrants,
    userResourceId: skillUserGrants.skillId,
    groupGrants: skillGroupGrants,
    groupResourceId: skillGroupGrants.skillId,
    available: sql`${skills.deletedAt} is null`,
    managedBy: (userId: string) => eq(skills.userId, userId),
    personal: {
      id: skills.id,
      owner: skills.userId,
      audience: skills.audience,
      userGrantUser: skillUserGrants.userId,
      groupGrantGroup: skillGroupGrants.groupId,
      use: "skillsUse" as const,
      create: "skillsCreate" as const,
      shareRight: groupMembers.shareSkills,
    },
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
    // Admin-authored: no member uses it by a sharing right, and its own access rule decides use.
    personal: null,
  },
  integration: {
    table: integrationConfigs,
    userGrants: integrationUserGrants,
    userResourceId: integrationUserGrants.integrationId,
    groupGrants: integrationGroupGrants,
    groupResourceId: integrationGroupGrants.integrationId,
    // A person's own MCP server is theirs alone; grants on it would mean nothing.
    available: sql`${integrationConfigs.ownerUserId} is null`,
    managedBy: (userId: string) =>
      sql`exists(select 1 from ${user} where ${user.id} = ${userId} and ${user.role} = 'admin')`,
    // Admin-authored: no member uses it by a sharing right, and its own access rule decides use.
    personal: null,
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
    personal: {
      id: unknown;
      owner: unknown;
      audience: unknown;
      userGrantUser: unknown;
      groupGrantGroup: unknown;
      use: Capability;
      create: Capability;
      shareRight: unknown;
    } | null;
  }
>;

/** The kinds a person owns and shares: agents, collections and skills. */
export type PersonalKind = "agent" | "collection" | "skill";

/**
 * Who may read and use a personal resource: the owner, anyone granted it
 * directly or through a group, or everyone once published to the instance;
 * all while they may use the kind and its owner may still create it. Edit
 * rights stay the owner's, and being an admin grants no read.
 */
export const readableBy = (kind: PersonalKind, userId: string): SQL => {
  const { available, userGrants, userResourceId, groupGrants, groupResourceId, personal } =
    sharingResources[kind];
  return sql`(
    ${available}
    and ${capabilityAllowedSql(userId, personal.use)}
    and ${capabilityAllowedSql(personal.owner, personal.create)}
    and (
      ${personal.owner} = ${userId}
      or ${personal.audience} = 'instance'
      or exists (
        select 1 from ${userGrants}
        where ${userResourceId} = ${personal.id} and ${personal.userGrantUser} = ${userId}
      )
      or exists (
        select 1 from ${groupGrants}
        join ${groupMembers} on ${groupMembers.groupId} = ${personal.groupGrantGroup}
        where ${groupResourceId} = ${personal.id} and ${groupMembers.userId} = ${userId}
      )
    )
  )`;
};
