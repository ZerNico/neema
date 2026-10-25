import { Folder01Icon } from "@hugeicons/core-free-icons";
import { listSource } from "~/modules/search/registry.ts";
import { m } from "~/paraglide/messages.js";
import { projectsQuery } from "./queries.ts";

export const useProjectSearch = listSource({
  // A getter, so the heading is read in the page's language when shown.
  get heading() {
    return m.projects_title();
  },
  icon: Folder01Icon,
  query: projectsQuery,
  allowed: (capabilities) => capabilities.projectsUse,
  text: (project) => `${project.description} ${project.ownerName}`,
  detail: (project) => project.description || undefined,
  href: (project) => `/projects/${project.id}`,
});
