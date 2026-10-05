import type { ProjectRole } from "../schema.ts";

export const roleLabel: Record<ProjectRole, string> = {
  owner: "Owner",
  editor: "Can edit",
  viewer: "Can view",
};
