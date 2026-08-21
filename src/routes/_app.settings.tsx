import { Brain02Icon, UserCircleIcon } from "@hugeicons/core-free-icons";
import { Outlet, createFileRoute } from "@tanstack/react-router";
import { AdminShell } from "~/modules/admin/ui/admin-shell.tsx";

export const Route = createFileRoute("/_app/settings")({
  component: SettingsLayout,
});

function SettingsLayout() {
  return (
    <AdminShell
      title="Settings"
      rootPath="/settings"
      items={[
        {
          to: "/settings/profile",
          label: "Profile",
          icon: UserCircleIcon,
          matchPrefix: "/settings/profile",
        },
        {
          to: "/settings/memory",
          label: "Memory",
          icon: Brain02Icon,
          matchPrefix: "/settings/memory",
        },
      ]}
    >
      <Outlet />
    </AdminShell>
  );
}
