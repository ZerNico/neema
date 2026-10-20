import { Outlet, createFileRoute } from "@tanstack/react-router";
import { SectionShell } from "~/ui/page-shell.tsx";
import { useDesktop } from "~/modules/desktop/client/bridge.ts";
import { settingsSections } from "~/modules/settings/sections.ts";

export const Route = createFileRoute("/_app/settings")({
  component: SettingsLayout,
});

function SettingsLayout() {
  const desktop = useDesktop();
  return (
    <SectionShell title="Settings" rootPath="/settings" items={settingsSections(desktop !== null)}>
      <Outlet />
    </SectionShell>
  );
}
