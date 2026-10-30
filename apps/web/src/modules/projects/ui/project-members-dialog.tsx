import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useSessionUser } from "~/modules/auth/client.ts";
import { MembersDialog, type MemberChange } from "~/modules/sharing/ui/members-dialog.tsx";
import { useConfirm } from "~/ui/confirm-context.ts";
import { toastError } from "~/ui/error-toast.ts";
import { Button } from "~/ui/primitives/button";
import { m } from "~/paraglide/messages.js";
import { projectMembersQuery } from "../client/queries.ts";
import type { ProjectDetail } from "../schema.ts";
import {
  addProjectGroup,
  addProjectMember,
  removeProjectGroup,
  removeProjectMember,
  setProjectMemberRole,
} from "../server/functions.ts";

const send = (projectId: string, change: MemberChange) => {
  switch (change.action) {
    case "addUser":
      return addProjectMember({ data: { projectId, email: change.email, role: change.role } });
    case "setUserRole":
      return setProjectMemberRole({
        data: { projectId, userId: change.userId, role: change.role },
      });
    case "removeUser":
      return removeProjectMember({ data: { projectId, userId: change.userId } });
    case "addGroup":
      return addProjectGroup({ data: { projectId, groupId: change.groupId, role: change.role } });
    case "removeGroup":
      return removeProjectGroup({ data: { projectId, groupId: change.groupId } });
  }
};

/** Who is in a project. The owner adds people and groups; a direct member may leave. */
export function ProjectMembersDialog({
  project,
  open,
  onOpenChange,
}: {
  project: ProjectDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const me = useSessionUser();
  const members = useQuery({ ...projectMembersQuery(project.id), enabled: open });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["projects"] });
  const leave = useMutation({
    mutationFn: (userId: string) =>
      removeProjectMember({ data: { projectId: project.id, userId } }),
    onSuccess: async () => {
      onOpenChange(false);
      await refresh();
      await navigate({ to: "/projects" });
    },
    onError: (error) => toastError(m.projects_members_leave_failed(), error),
  });
  const manage = project.role === "owner";
  return (
    <MembersDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && leave.isPending) return;
        onOpenChange(next);
      }}
      title={m.projects_members_title()}
      description={m.projects_members_description()}
      owner={{ id: project.ownerId, name: project.ownerName }}
      members={members}
      manage={manage}
      onChange={async (change) => {
        await send(project.id, change);
        await refresh();
      }}
      footer={
        // Only a direct membership can be left; one through a group is the group's.
        manage || !members.data?.users.some((member) => member.userId === me?.id) ? null : (
          <Button
            variant="outline"
            disabled={leave.isPending}
            onClick={() => {
              void confirm({
                title: m.projects_members_leave_title({ name: project.name }),
                description: m.projects_members_leave_description(),
                confirmLabel: m.projects_members_leave(),
              }).then((confirmed) => {
                if (confirmed && me) leave.mutate(me.id);
              });
            }}
          >
            {m.projects_members_leave()}
          </Button>
        )
      }
    />
  );
}
