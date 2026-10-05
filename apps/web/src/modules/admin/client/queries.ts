import { queryOptions } from "@tanstack/react-query";
import { authClient } from "~/modules/auth/client.ts";
import {
  listGroupMembers,
  listGroupMemberships,
  listGroups,
  listModelAccess,
  listModels,
  listProviders,
} from "../server/functions.ts";

export const groupsQuery = queryOptions({
  queryKey: ["admin", "groups"],
  queryFn: () => listGroups(),
});

export const membershipsQuery = queryOptions({
  queryKey: ["admin", "group-memberships"],
  queryFn: () => listGroupMemberships(),
});

export const membersQuery = (groupId: string) =>
  queryOptions({
    queryKey: ["admin", "group-members", groupId],
    queryFn: () => listGroupMembers({ data: { groupId } }),
  });

export const usersQuery = queryOptions({
  queryKey: ["admin", "users"],
  queryFn: async () => {
    const { data, error } = await authClient.admin.listUsers({
      query: { limit: 100, sortBy: "createdAt", sortDirection: "asc" },
    });
    if (error) throw new Error(error.message);
    return data.users;
  },
});

export const providersQuery = queryOptions({
  queryKey: ["admin", "providers"],
  queryFn: () => listProviders(),
});

export const modelsQuery = queryOptions({
  queryKey: ["admin", "models"],
  queryFn: () => listModels(),
});

export const modelAccessQuery = queryOptions({
  queryKey: ["admin", "model-access"],
  queryFn: () => listModelAccess(),
});
