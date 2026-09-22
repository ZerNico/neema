import {
  Analytics01Icon,
  CloudServerIcon,
  CodeIcon,
  Key01Icon,
  FolderLibraryIcon,
  UserGroupIcon,
  UserMultipleIcon,
  WrenchIcon,
} from "@hugeicons/core-free-icons";
import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";
import { SectionShell } from "~/ui/page-shell.tsx";

export const Route = createFileRoute("/_app/admin")({
  beforeLoad: ({ context }) => {
    if (context.user.role !== "admin") throw redirect({ to: "/" });
  },
  component: AdminLayout,
});

function AdminLayout() {
  return (
    <SectionShell
      title="Admin"
      rootPath="/admin"
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
          to: "/admin/custom-tools",
          label: "Custom tools",
          icon: CodeIcon,
          matchPrefix: "/admin/custom-tools",
        },
        {
          to: "/admin/documents",
          label: "Documents",
          icon: FolderLibraryIcon,
          matchPrefix: "/admin/documents",
        },
        {
          to: "/admin/auth",
          label: "Sign-in",
          icon: Key01Icon,
          matchPrefix: "/admin/auth",
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
        {
          to: "/admin/analytics",
          label: "Analytics",
          icon: Analytics01Icon,
          matchPrefix: "/admin/analytics",
        },
      ]}
    >
      <Outlet />
    </SectionShell>
  );
}
