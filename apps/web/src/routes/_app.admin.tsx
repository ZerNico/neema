import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";
import { SectionShell } from "~/ui/page-shell.tsx";
import { ADMIN_SECTIONS } from "~/modules/admin/sections.ts";
import { BUILD_LABEL } from "~/build-info.ts";
import { m } from "~/paraglide/messages.js";

export const Route = createFileRoute("/_app/admin")({
  beforeLoad: ({ context }) => {
    if (context.user.role !== "admin") throw redirect({ to: "/" });
  },
  component: AdminLayout,
});

function AdminLayout() {
  return (
    <SectionShell
      title={m.ui_page_admin()}
      rootPath="/admin"
      items={ADMIN_SECTIONS}
      footer={`neema ${BUILD_LABEL}`}
    >
      <Outlet />
    </SectionShell>
  );
}
