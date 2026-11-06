import { createFileRoute } from "@tanstack/react-router";
import { PublicDocumentPage } from "~/modules/documents/ui/public-document-page.tsx";
import { getPublicDocument } from "~/modules/documents/server/public-document-functions.ts";

/** A document's public link, outside the signed-in app; a link that no longer opens it shows the same page. */
export const Route = createFileRoute("/d/$token")({
  loader: ({ params }) => getPublicDocument({ data: { token: params.token } }),
  head: ({ loaderData }) => ({
    meta: [
      { title: loaderData?.title ?? "neema" },
      // A link is shared on purpose; it is not for search engines to find.
      { name: "robots", content: "noindex, nofollow" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  component: PublicDocumentRoute,
});

function PublicDocumentRoute() {
  return <PublicDocumentPage document={Route.useLoaderData()} />;
}
