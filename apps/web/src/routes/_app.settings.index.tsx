import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

// On mobile /settings is the nav screen itself (SectionShell hides content at
// the root). On desktop the nav is always visible, so land on profile.
export const Route = createFileRoute("/_app/settings/")({
  component: SettingsIndex,
});

function SettingsIndex() {
  const navigate = useNavigate();
  useEffect(() => {
    if (window.matchMedia("(min-width: 768px)").matches) {
      void navigate({ to: "/settings/profile", replace: true });
    }
  }, [navigate]);
  return null;
}
