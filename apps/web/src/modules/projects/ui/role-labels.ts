import type { ProjectRole } from "../schema.ts";

import { m } from "~/paraglide/messages.js";

/** Each role's name, as a message so it reads in the page's language. */
export const roleLabel: Record<ProjectRole, () => string> = {
  owner: m.projects_role_owner,
  editor: m.projects_role_editor,
  viewer: m.projects_role_viewer,
};
