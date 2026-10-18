import { Schema } from "effect";
import { EntityId } from "~/entity-id.ts";

export const PROJECT_LIMITS = {
  name: 120,
  description: 500,
  instructions: 20_000,
  /** Direct members and group grants each; a project is a team, not a directory. */
  members: 200,
} as const;

export const PROJECT_MEMORY_LIMITS = { content: 500, perProject: 100 } as const;

/** The owner is the one account that made it; everyone else is an editor or a viewer. */
export const ProjectRole = Schema.Literals(["owner", "editor", "viewer"]);
export type ProjectRole = typeof ProjectRole.Type;
export const ProjectMemberRole = Schema.Literals(["editor", "viewer"]);
export type ProjectMemberRole = typeof ProjectMemberRole.Type;
/** What each role may do; one table so server and UI never disagree. */
export const projectCan = {
  edit: (role: ProjectRole | null) => role === "owner" || role === "editor",
  manage: (role: ProjectRole | null) => role === "owner",
} as const;

const Name = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(PROJECT_LIMITS.name),
  Schema.isPattern(/\S/),
);
const Description = Schema.String.check(Schema.isMaxLength(PROJECT_LIMITS.description));
const Instructions = Schema.String.check(Schema.isMaxLength(PROJECT_LIMITS.instructions));

export const ProjectIdInput = Schema.Struct({ projectId: EntityId });
export const CreateProjectInput = Schema.Struct({
  name: Name,
  description: Schema.optionalKey(Description),
  instructions: Schema.optionalKey(Instructions),
});
export type CreateProjectInput = typeof CreateProjectInput.Type;
export const UpdateProjectInput = Schema.Struct({
  projectId: EntityId,
  name: Schema.optionalKey(Name),
  description: Schema.optionalKey(Description),
  instructions: Schema.optionalKey(Instructions),
});
export type UpdateProjectInput = typeof UpdateProjectInput.Type;
export const AddProjectMemberInput = Schema.Struct({
  projectId: EntityId,
  email: Schema.String.check(Schema.isMinLength(3), Schema.isMaxLength(254)),
  role: ProjectMemberRole,
});
export const SetProjectMemberRoleInput = Schema.Struct({
  projectId: EntityId,
  userId: EntityId,
  role: ProjectMemberRole,
});
export const RemoveProjectMemberInput = Schema.Struct({ projectId: EntityId, userId: EntityId });
export const AddProjectGroupInput = Schema.Struct({
  projectId: EntityId,
  groupId: EntityId,
  role: ProjectMemberRole,
});
export const RemoveProjectGroupInput = Schema.Struct({ projectId: EntityId, groupId: EntityId });
export const MoveConversationInput = Schema.Struct({
  conversationId: EntityId,
  projectId: Schema.NullOr(EntityId),
});
export const CreateProjectDocumentInput = Schema.Struct({
  projectId: EntityId,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});

export interface ProjectSummary {
  id: string;
  name: string;
  description: string;
  role: ProjectRole;
  ownerName: string;
  updatedAt: string;
}
export interface ProjectDetail extends ProjectSummary {
  instructions: string;
  ownerId: string;
  createdAt: string;
}
export interface ProjectMembers {
  users: ReadonlyArray<{ userId: string; name: string; email: string; role: ProjectMemberRole }>;
  groups: ReadonlyArray<{ groupId: string; name: string; role: ProjectMemberRole }>;
  /** Groups this person may grant the project to; empty unless they manage it. */
  eligibleGroups: ReadonlyArray<{ id: string; name: string }>;
}
/** One of the signed-in person's own chats in a project. */
export interface ProjectChat {
  id: string;
  title: string | null;
  lastActivityAt: string;
}
/** What an attempt in a project chat runs with; snapshotted beside the answer. */
export interface ResolvedProject {
  id: string;
  name: string;
  instructions: string;
  role: ProjectRole;
}

export const ProjectMemoryInput = Schema.Struct({
  projectId: EntityId,
  content: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(PROJECT_MEMORY_LIMITS.content),
  ),
});
export const UpdateProjectMemoryInput = Schema.Struct({
  projectId: EntityId,
  memoryId: EntityId,
  content: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(PROJECT_MEMORY_LIMITS.content),
  ),
});
export const DeleteProjectMemoryInput = Schema.Struct({ projectId: EntityId, memoryId: EntityId });
/** A fact the project keeps; who added it is shown, never where it came from. */
export interface ProjectMemory {
  id: string;
  content: string;
  origin: "manual" | "model";
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}
