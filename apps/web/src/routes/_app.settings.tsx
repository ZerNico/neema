import {
  Analytics01Icon,
  Brain02Icon,
  ComputerIcon,
  UserCircleIcon,
} from "@hugeicons/core-free-icons";
import { Outlet, createFileRoute } from "@tanstack/react-router";
import { SectionShell } from "~/ui/page-shell.tsx";

export const Route = createFileRoute("/_app/settings")({
  component: SettingsLayout,
});

function SettingsLayout() {
  return (
    <SectionShell
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
        {
          to: "/settings/devices",
          label: "Devices",
          icon: ComputerIcon,
          matchPrefix: "/settings/devices",
        },
        {
          to: "/settings/usage",
          label: "Usage",
          icon: Analytics01Icon,
          matchPrefix: "/settings/usage",
        },
      ]}
    >
      <Outlet />
    </SectionShell>
  );
}
