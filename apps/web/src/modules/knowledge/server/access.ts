import { sql, type SQL } from "drizzle-orm";
import {
  agentGroupGrants,
  agentUserGrants,
  agents,
  groupMembers,
  knowledgeCollectionGroupGrants,
  knowledgeCollectionUserGrants,
  knowledgeCollections,
} from "~/db/schema/index.ts";

/**
 * Who may read/use a collection: the owner, anyone it was granted to directly,
 * any member of a granted group, or every signed-in user once an admin
 * published it to the instance.
 *
 * Read access is additive and deliberately separate from edit rights, which
 * are the owner's alone. Being an admin is not on this list: publishing a
 * collection is an administrative act, reading someone's private documents is
 * not.
 */
export const collectionReadable = (userId: string): SQL =>
  sql`(
    ${knowledgeCollections.userId} = ${userId}
    or ${knowledgeCollections.audience} = 'instance'
    or exists (
      select 1 from ${knowledgeCollectionUserGrants}
      where ${knowledgeCollectionUserGrants.collectionId} = ${knowledgeCollections.id}
        and ${knowledgeCollectionUserGrants.userId} = ${userId}
    )
    or exists (
      select 1 from ${knowledgeCollectionGroupGrants}
      join ${groupMembers}
        on ${groupMembers.groupId} = ${knowledgeCollectionGroupGrants.groupId}
      where ${knowledgeCollectionGroupGrants.collectionId} = ${knowledgeCollections.id}
        and ${groupMembers.userId} = ${userId}
    )
  )`;

/** Same rule for agents. An agent grant never extends to its collections. */
export const agentReadable = (userId: string): SQL =>
  sql`(
    ${agents.userId} = ${userId}
    or ${agents.audience} = 'instance'
    or exists (
      select 1 from ${agentUserGrants}
      where ${agentUserGrants.agentId} = ${agents.id}
        and ${agentUserGrants.userId} = ${userId}
    )
    or exists (
      select 1 from ${agentGroupGrants}
      join ${groupMembers} on ${groupMembers.groupId} = ${agentGroupGrants.groupId}
      where ${agentGroupGrants.agentId} = ${agents.id}
        and ${groupMembers.userId} = ${userId}
    )
  )`;

/**
 * Correlated form for queries that reach a collection through a document,
 * version or chunk rather than selecting from `knowledge_collections` itself.
 */
export const collectionIdReadable = (userId: string, collectionId: SQL): SQL =>
  sql`exists (
    select 1 from ${knowledgeCollections}
    where ${knowledgeCollections.id} = ${collectionId}
      and ${collectionReadable(userId)}
  )`;
