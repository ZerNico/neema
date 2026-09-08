import { queryOptions } from "@tanstack/react-query";
import { getSkill, getSkillDetail, listSkills } from "../server/functions.ts";
export const skillsQuery = queryOptions({ queryKey: ["skills"], queryFn: () => listSkills() });
export const skillQuery = (skillId: string) =>
  queryOptions({
    queryKey: ["skills", skillId, "metadata"],
    queryFn: () => getSkill({ data: { skillId } }),
  });
export const skillDetailQuery = (skillId: string) =>
  queryOptions({
    queryKey: ["skills", skillId, "owner"],
    queryFn: () => getSkillDetail({ data: { skillId } }),
  });
