import { sql, type SQL } from "drizzle-orm";
import { groupMembers, skillGroupGrants, skills, skillUserGrants } from "~/db/schema/index.ts";

/** Metadata/invocation ACL only. Bodies and management remain owner-only. */
export const skillReadable = (userId: string): SQL => sql`(
  ${skills.deletedAt} is null and (
    ${skills.userId} = ${userId} or ${skills.audience} = 'instance'
    or exists(select 1 from ${skillUserGrants} where ${skillUserGrants.skillId} = ${skills.id} and ${skillUserGrants.userId} = ${userId})
    or exists(select 1 from ${skillGroupGrants} join ${groupMembers} on ${groupMembers.groupId} = ${skillGroupGrants.groupId}
      where ${skillGroupGrants.skillId} = ${skills.id} and ${groupMembers.userId} = ${userId})
  )
)`;
