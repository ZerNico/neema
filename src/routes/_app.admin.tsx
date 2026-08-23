import {
  CloudServerIcon,
  UserGroupIcon,
  UserMultipleIcon,
  WrenchIcon,
} from "@hugeicons/core-free-icons";
import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";
import { AdminShell } from "~/modules/admin/ui/admin-shell.tsx";

export const Route = createFileRoute("/_app/admin")({
  beforeLoad: ({ context }) => {
    if (context.user.role !== "admin") throw redirect({ to: "/" });
  },
  component: AdminLayout,
});

function AdminLayout() {
  return (
    <AdminShell
      items={[
        {
          to: "/admin/providers",
          label: "Providers",
          icon: CloudServerIcon,
          matchPrefix: "/admin/providers",
        },
        {
          to: "/admin/tools",
          label: "Tools",
          icon: WrenchIcon,
          matchPrefix: "/admin/tools",
        },
        {
          to: "/admin/users",
          label: "Users",
          icon: UserMultipleIcon,
          matchPrefix: "/admin/users",
        },
        {
          to: "/admin/groups",
          label: "Groups",
          icon: UserGroupIcon,
          matchPrefix: "/admin/groups",
        },
      ]}
    >
      <Outlet />
    </AdminShell>
  );
}
