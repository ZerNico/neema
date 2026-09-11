import { createFileRoute } from "@tanstack/react-router";
import { skillDetailQuery, skillQuery } from "~/modules/skills/client/queries.ts";
import { SkillEditorPage } from "~/modules/skills/ui/skill-editor-page.tsx";

export const Route = createFileRoute("/_app/skills/$skillId")({
  loader: async ({ context, params }) => {
    // Prefetch, not ensure: access loss renders the page's own error state.
    const metadata = skillQuery(params.skillId);
    await context.queryClient.prefetchQuery({ ...metadata, retry: false });
    // The package files are owner-only and would 404 for a recipient, so they
    // are fetched only once the metadata says this reader can edit.
    if (context.queryClient.getQueryData(metadata.queryKey)?.canEdit)
      await context.queryClient.prefetchQuery({
        ...skillDetailQuery(params.skillId),
        retry: false,
      });
  },
  component: SkillRoute,
});

function SkillRoute() {
  const { skillId } = Route.useParams();
  return <SkillEditorPage skillId={skillId} />;
}
