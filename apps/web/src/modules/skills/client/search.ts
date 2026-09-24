import { Book02Icon } from "@hugeicons/core-free-icons";
import { listSource } from "~/modules/search/registry.ts";
import { skillsQuery } from "./queries.ts";

export const useSkillSearch = listSource({
  heading: "Skills",
  icon: Book02Icon,
  query: skillsQuery,
  allowed: (capabilities) => capabilities.skillsUse,
  text: (skill) => skill.description,
  detail: (skill) => skill.description || undefined,
  href: (skill) => `/skills/${skill.id}`,
});
