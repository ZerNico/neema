import { createFileRoute } from "@tanstack/react-router";
import { knowledgeCollectionQuery } from "~/modules/knowledge/client/queries.ts";
import { CollectionPage } from "~/modules/knowledge/ui/collection-page.tsx";

export const Route = createFileRoute("/_app/knowledge/$collectionId")({
  loader: async ({ context, params }) => {
    // Prefetch, not ensure: access loss renders the page's own error state.
    await context.queryClient.prefetchQuery({
      ...knowledgeCollectionQuery(params.collectionId),
      retry: false,
    });
  },
  component: CollectionRoute,
});

function CollectionRoute() {
  const { collectionId } = Route.useParams();
  return <CollectionPage collectionId={collectionId} />;
}
