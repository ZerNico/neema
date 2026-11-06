import { createFileRoute } from "@tanstack/react-router";
import {
  projectChatsQuery,
  projectMemoriesQuery,
  projectMembersQuery,
  projectQuery,
} from "~/modules/projects/client/queries.ts";
import { projectDocumentsQuery } from "~/modules/documents/client/document-queries.ts";
import { ProjectPage } from "~/modules/projects/ui/project-page.tsx";

export const Route = createFileRoute("/_app/projects/$projectId")({
  // A document to open once the page is up, such as a copy just made from elsewhere.
  validateSearch: (search: Record<string, unknown>): { document?: string } =>
    typeof search["document"] === "string" && search["document"].length <= 128
      ? { document: search["document"] }
      : {},
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(projectQuery(params.projectId));
    await Promise.all([
      context.queryClient.prefetchQuery(projectChatsQuery(params.projectId)),
      context.queryClient.prefetchQuery(projectDocumentsQuery(params.projectId)),
      context.queryClient.prefetchQuery(projectMemoriesQuery(params.projectId)),
      context.queryClient.prefetchQuery(projectMembersQuery(params.projectId)),
    ]);
  },
  component: function ProjectRoute() {
    const { projectId } = Route.useParams();
    const { document } = Route.useSearch();
    return <ProjectPage key={projectId} projectId={projectId} openDocument={document ?? null} />;
  },
});
