import { Outlet, createFileRoute } from "@tanstack/react-router";
import { SectionShell } from "~/ui/page-shell.tsx";
import { SETTINGS_SECTIONS } from "~/modules/settings/sections.ts";

export const Route = createFileRoute("/_app/settings")({
  component: SettingsLayout,
});

function SettingsLayout() {
  return (
    <SectionShell title="Settings" rootPath="/settings" items={SETTINGS_SECTIONS}>
      <Outlet />
    </SectionShell>
  );
}
