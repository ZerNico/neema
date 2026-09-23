import { sql, type SQL } from "drizzle-orm";
import { groupMembers, skillGroupGrants, skills, skillUserGrants } from "~/db/schema/index.ts";
import { capabilityAllowedSql } from "~/modules/groups/server/policy.ts";

/** Metadata/invocation ACL only. Bodies and management remain owner-only. */
export const skillReadable = (userId: string): SQL => sql`(
  ${skills.deletedAt} is null
  and ${capabilityAllowedSql(userId, "skillsUse")}
  and ${capabilityAllowedSql(skills.userId, "skillsCreate")}
  and (
    ${skills.userId} = ${userId} or ${skills.audience} = 'instance'
    or exists(select 1 from ${skillUserGrants} where ${skillUserGrants.skillId} = ${skills.id} and ${skillUserGrants.userId} = ${userId})
    or exists(select 1 from ${skillGroupGrants} join ${groupMembers} on ${groupMembers.groupId} = ${skillGroupGrants.groupId}
      where ${skillGroupGrants.skillId} = ${skills.id} and ${groupMembers.userId} = ${userId})
  )
)`;
