import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";
import { SectionShell } from "~/ui/page-shell.tsx";
import { ADMIN_SECTIONS } from "~/modules/admin/sections.ts";

export const Route = createFileRoute("/_app/admin")({
  beforeLoad: ({ context }) => {
    if (context.user.role !== "admin") throw redirect({ to: "/" });
  },
  component: AdminLayout,
});

function AdminLayout() {
  return (
    <SectionShell title="Admin" rootPath="/admin" items={ADMIN_SECTIONS}>
      <Outlet />
    </SectionShell>
  );
}
