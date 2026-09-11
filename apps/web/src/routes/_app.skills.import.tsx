import { createFileRoute } from "@tanstack/react-router";
import { SkillImportPage } from "~/modules/skills/ui/skill-import-page.tsx";

export const Route = createFileRoute("/_app/skills/import")({
  // `?source=<url>&path=<package>` is the package being reviewed. Reading it
  // costs upstream requests, so it is never preloaded on hover.
  validateSearch: (search: Record<string, unknown>): { source?: string; path?: string } => ({
    ...(typeof search["source"] === "string" && search["source"].length <= 2048
      ? { source: search["source"] }
      : {}),
    ...(typeof search["path"] === "string" && search["path"].length <= 240
      ? { path: search["path"] }
      : {}),
  }),
  preload: false,
  component: SkillImportRoute,
});

function SkillImportRoute() {
  return <SkillImportPage {...Route.useSearch()} />;
}
