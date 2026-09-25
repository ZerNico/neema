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
    return <ProjectPage key={projectId} projectId={projectId} />;
  },
});
