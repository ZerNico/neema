import { createFileRoute } from "@tanstack/react-router";
import { projectsQuery } from "~/modules/projects/client/queries.ts";
import { ProjectsPage } from "~/modules/projects/ui/projects-page.tsx";

export const Route = createFileRoute("/_app/projects/")({
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(projectsQuery);
  },
  component: ProjectsPage,
});
