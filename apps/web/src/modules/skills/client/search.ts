import { Book02Icon } from "@hugeicons/core-free-icons";
import { listSource } from "~/modules/search/registry.ts";
import { m } from "~/paraglide/messages.js";
import { skillsQuery } from "./queries.ts";

export const useSkillSearch = listSource({
  // A getter, so the heading is read in the page's language when shown.
  get heading() {
    return m.skills_title();
  },
  icon: Book02Icon,
  query: skillsQuery,
  allowed: (capabilities) => capabilities.skillsUse,
  text: (skill) => skill.description,
  detail: (skill) => skill.description || undefined,
  href: (skill) => `/skills/${skill.id}`,
});
