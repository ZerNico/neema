import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * On mobile /admin is the nav screen itself (SectionShell hides content at the
 * root). On desktop the nav is always visible, so land on providers instead of
 * an empty pane. The loader runs in the browser, so it can read the viewport
 * before anything mounts.
 */
export const Route = createFileRoute("/_app/admin/")({
  loader: () => {
    if (window.matchMedia("(min-width: 768px)").matches)
      throw redirect({ to: "/admin/providers", replace: true });
  },
  component: () => null,
});
