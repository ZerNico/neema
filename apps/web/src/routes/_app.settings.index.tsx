import { createFileRoute, redirect } from "@tanstack/react-router";

// On mobile /settings is the nav screen itself (SectionShell hides content at
// the root). On desktop the nav is always visible, so land on profile. The
// loader runs in the browser (client-rendered SPA), so the viewport is known
// before anything mounts.
export const Route = createFileRoute("/_app/settings/")({
  loader: () => {
    if (window.matchMedia("(min-width: 768px)").matches)
      throw redirect({ to: "/settings/profile", replace: true });
  },
  component: () => null,
});
