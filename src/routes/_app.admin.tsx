import { Outlet, createFileRoute, Link, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/admin")({
  beforeLoad: ({ context }) => {
    if (context.user.role !== "admin") throw redirect({ to: "/" });
  },
  component: AdminLayout,
});

function AdminLayout() {
  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col gap-6 overflow-y-auto p-6">
      <div className="flex items-center gap-4">
        <h1 className="text-xl font-semibold">Admin</h1>
        <nav className="flex gap-3 text-sm">
          <Link
            to="/admin"
            activeOptions={{ exact: true }}
            className="text-muted-foreground [&.active]:text-foreground [&.active]:font-medium"
          >
            Providers
          </Link>
          <Link
            to="/admin/users"
            className="text-muted-foreground [&.active]:text-foreground [&.active]:font-medium"
          >
            Users
          </Link>
        </nav>
      </div>
      <Outlet />
    </div>
  );
}
