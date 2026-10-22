import { createServerFn } from "@tanstack/react-start";
import { Effect, Schema } from "effect";
import { requireSession } from "~/modules/auth/server/middleware.ts";
import { refusal } from "~/server/refusal.ts";
import { runServerFn } from "~/server/run-server-fn.ts";
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
import {
  PinProjectFileVersionInput,
  PROJECT_FILE_LIMITS,
  ProjectFileIdInput,
  RestoreProjectFileInput,
  SaveAttachmentToProjectInput,
} from "../files.ts";
import { ProjectFileService } from "./project-files.ts";
import { ProjectMemoryService } from "./project-memory.ts";
import { ProjectService } from "./service.ts";

const standard = Schema.toStandardSchemaV1;
const run = <A>(
  body: (
    service: ProjectService["Service"],
  ) => Effect.Effect<A, ProjectNotAvailable | ProjectRejected>,
) => runServerFn(Effect.flatMap(ProjectService, body));

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
) => runServerFn(Effect.flatMap(ProjectMemoryService, body));
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

const runFiles = <A>(
  body: (
    service: ProjectFileService["Service"],
  ) => Effect.Effect<A, ProjectNotAvailable | ProjectRejected>,
) => runServerFn(Effect.flatMap(ProjectFileService, body));
/** FormData at the root, so the client sends multipart; fields are checked here. */
const readFileUpload = (data: FormData) => {
  const file = data.get("file");
  const projectId = data.get("projectId");
  const fileId = data.get("fileId");
  const basedOn = data.get("basedOnVersion");
  if (!(file instanceof File) || typeof projectId !== "string" || !projectId)
    throw refusal(400, "Expected a file");
  if (file.size > PROJECT_FILE_LIMITS.fileBytes)
    throw refusal(413, "The file is larger than 50 MB");
  return {
    file,
    projectId,
    fileId: typeof fileId === "string" && fileId ? fileId : undefined,
    basedOnVersion:
      typeof basedOn === "string" && /^\d+$/.test(basedOn) ? Number(basedOn) : undefined,
  };
};
export const listProjectFiles = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(standard(ProjectIdInput))
  .handler(({ context, data }) =>
    runFiles((service) => service.list(context.session.user.id, data.projectId)),
  );
export const listProjectFileVersions = createServerFn({ method: "GET" })
  .middleware([requireSession])
  .validator(standard(ProjectFileIdInput))
  .handler(({ context, data }) =>
    runFiles((service) => service.versions(context.session.user.id, data.fileId)),
  );
export const uploadProjectFile = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator((data: FormData) => data)
  .handler(async ({ context, data }) => {
    const upload = readFileUpload(data);
    const bytes = new Uint8Array(await upload.file.arrayBuffer());
    return runFiles((service) =>
      service.write(
        { origin: "user", userId: context.session.user.id },
        {
          projectId: upload.projectId,
          fileId: upload.fileId,
          name: upload.file.name,
          bytes,
          basedOnVersion: upload.basedOnVersion,
        },
      ),
    );
  });
export const restoreProjectFileVersion = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(RestoreProjectFileInput))
  .handler(({ context, data }) =>
    runFiles((service) =>
      service.restore(context.session.user.id, data.versionId, data.basedOnVersion),
    ),
  );
export const pinProjectFileVersion = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(PinProjectFileVersionInput))
  .handler(({ context, data }) =>
    runFiles((service) =>
      service.pin(context.session.user.id, data.versionId, {
        pinned: data.pinned,
        label: data.label,
      }),
    ),
  );
export const deleteProjectFile = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(ProjectFileIdInput))
  .handler(({ context, data }) =>
    runFiles((service) => service.remove(context.session.user.id, data.fileId)),
  );
/** "Save to project" on a chat attachment the person can see. */
export const saveAttachmentToProject = createServerFn({ method: "POST" })
  .middleware([requireSession])
  .validator(standard(SaveAttachmentToProjectInput))
  .handler(({ context, data }) =>
    runFiles((service) =>
      service.saveAttachment(
        { origin: "user", userId: context.session.user.id },
        { projectId: data.projectId, attachment: { id: data.attachmentId } },
      ),
    ),
  );
