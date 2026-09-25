import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { requireSession } from "~/modules/auth/server/middleware.ts";
import { runtime } from "~/server/runtime.ts";
import type { ProjectNotAvailable, ProjectRejected } from "../errors.ts";
import {
  AddProjectGroupInput,
  AddProjectMemberInput,
  CreateProjectInput,
  DeleteProjectMemoryInput,
  MoveConversationInput,
  ProjectIdInput,
  ProjectMemoryInput,
  RemoveProjectGroupInput,
  RemoveProjectMemberInput,
  SetProjectMemberRoleInput,
  UpdateProjectInput,
  UpdateProjectMemoryInput,
} from "../schema.ts";
import { ProjectMemoryService } from "./project-memory.ts";
import { ProjectService } from "./service.ts";

const standard = Schema.toStandardSchemaV1;
const run = <A>(
  body: (
    service: ProjectService["Service"],
  ) => Effect.Effect<A, ProjectNotAvailable | ProjectRejected>,
) =>
  runtime.runPromise(
    Effect.flatMap(ProjectService, body).pipe(
      Effect.catchTag("ProjectNotAvailable", () =>
        Effect.die(new Response("Not found", { status: 404 })),
      ),
      Effect.catchTag("ProjectRejected", (error) =>
        Effect.die(new Response(error.reason, { status: 400 })),
      ),
    ),
  );

export const listProjects = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .handler(({ context }) => run((service) => service.list(context.session.user.id)));
export const getProject = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(standard(ProjectIdInput))
  .handler(({ context, data }) =>
    run((service) => service.get(context.session.user.id, data.projectId)),
  );
export const createProject = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(CreateProjectInput))
  .handler(({ context, data }) => run((service) => service.create(context.session.user.id, data)));
export const updateProject = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(UpdateProjectInput))
  .handler(({ context, data }) => run((service) => service.update(context.session.user.id, data)));
export const deleteProject = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(ProjectIdInput))
  .handler(({ context, data }) =>
    run((service) => service.remove(context.session.user.id, data.projectId)),
  );
export const getProjectMembers = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(standard(ProjectIdInput))
  .handler(({ context, data }) =>
    run((service) => service.members(context.session.user.id, data.projectId)),
  );
export const addProjectMember = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(AddProjectMemberInput))
  .handler(({ context, data }) =>
    run((service) =>
      service.changeMembers(context.session.user.id, data.projectId, {
        action: "addUser",
        email: data.email,
        role: data.role,
      }),
    ),
  );
export const setProjectMemberRole = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(SetProjectMemberRoleInput))
  .handler(({ context, data }) =>
    run((service) =>
      service.changeMembers(context.session.user.id, data.projectId, {
        action: "setUserRole",
        userId: data.userId,
        role: data.role,
      }),
    ),
  );
export const removeProjectMember = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(RemoveProjectMemberInput))
  .handler(({ context, data }) =>
    run((service) =>
      service.changeMembers(context.session.user.id, data.projectId, {
        action: "removeUser",
        userId: data.userId,
      }),
    ),
  );
export const addProjectGroup = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(AddProjectGroupInput))
  .handler(({ context, data }) =>
    run((service) =>
      service.changeMembers(context.session.user.id, data.projectId, {
        action: "addGroup",
        groupId: data.groupId,
        role: data.role,
      }),
    ),
  );
export const removeProjectGroup = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(RemoveProjectGroupInput))
  .handler(({ context, data }) =>
    run((service) =>
      service.changeMembers(context.session.user.id, data.projectId, {
        action: "removeGroup",
        groupId: data.groupId,
      }),
    ),
  );
export const listProjectChats = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(standard(ProjectIdInput))
  .handler(({ context, data }) =>
    run((service) => service.chats(context.session.user.id, data.projectId)),
  );
export const moveConversationToProject = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(MoveConversationInput))
  .handler(({ context, data }) =>
    run((service) => service.move(context.session.user.id, data.conversationId, data.projectId)),
  );

const runMemory = <A>(
  body: (
    service: ProjectMemoryService["Service"],
  ) => Effect.Effect<A, ProjectNotAvailable | ProjectRejected>,
) =>
  runtime.runPromise(
    Effect.flatMap(ProjectMemoryService, body).pipe(
      Effect.catchTag("ProjectNotAvailable", () =>
        Effect.die(new Response("Not found", { status: 404 })),
      ),
      Effect.catchTag("ProjectRejected", (error) =>
        Effect.die(new Response(error.reason, { status: 400 })),
      ),
    ),
  );
export const listProjectMemories = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(standard(ProjectIdInput))
  .handler(({ context, data }) =>
    runMemory((service) => service.list(context.session.user.id, data.projectId)),
  );
export const addProjectMemory = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(ProjectMemoryInput))
  .handler(({ context, data }) =>
    runMemory((service) => service.add(context.session.user.id, data.projectId, data.content)),
  );
export const updateProjectMemory = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(UpdateProjectMemoryInput))
  .handler(({ context, data }) =>
    runMemory((service) =>
      service.update(context.session.user.id, data.projectId, data.memoryId, data.content),
    ),
  );
export const deleteProjectMemory = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(DeleteProjectMemoryInput))
  .handler(({ context, data }) =>
    runMemory((service) => service.remove(context.session.user.id, data.projectId, data.memoryId)),
  );
