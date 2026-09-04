import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

// On mobile /admin is the nav screen itself (SectionShell hides content at the
// root). On desktop the nav is always visible, so land on providers instead
// of an empty pane. Viewport is unknown during SSR, hence the client effect.
export const Route = createFileRoute("/_app/admin/")({
  component: AdminIndex,
});

function AdminIndex() {
  const navigate = useNavigate();
  useEffect(() => {
    if (window.matchMedia("(min-width: 768px)").matches) {
      void navigate({ to: "/admin/providers", replace: true });
    }
  }, [navigate]);
  return null;
}
