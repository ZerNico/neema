import { queryOptions } from "@tanstack/react-query";
import {
  getProject,
  getProjectFileSettings,
  getProjectMembers,
  listProjectChats,
  listProjectFiles,
  listProjectFileVersions,
  listProjectMemories,
  listProjects,
} from "../server/functions.ts";

export const projectsQuery = queryOptions({
  queryKey: ["projects", "list"],
  queryFn: () => listProjects(),
  staleTime: 30_000,
});
export const projectQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", "detail", projectId],
    queryFn: () => getProject({ data: { projectId } }),
    staleTime: 30_000,
  });
export const projectMembersQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", "members", projectId],
    queryFn: () => getProjectMembers({ data: { projectId } }),
    staleTime: 30_000,
  });
export const projectChatsQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", "chats", projectId],
    queryFn: () => listProjectChats({ data: { projectId } }),
    staleTime: 30_000,
  });
export const projectMemoriesQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", "memories", projectId],
    queryFn: () => listProjectMemories({ data: { projectId } }),
    staleTime: 30_000,
  });
export const projectFilesQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["projects", "files", projectId],
    queryFn: () => listProjectFiles({ data: { projectId } }),
    staleTime: 30_000,
  });
export const projectFileVersionsQuery = (fileId: string) =>
  queryOptions({
    queryKey: ["projects", "file-versions", fileId],
    queryFn: () => listProjectFileVersions({ data: { fileId } }),
    staleTime: 30_000,
  });

export const projectFileSettingsQuery = queryOptions({
  queryKey: ["admin", "project-files"],
  queryFn: () => getProjectFileSettings(),
});
