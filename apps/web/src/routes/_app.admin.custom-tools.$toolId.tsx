import { createFileRoute } from "@tanstack/react-router";
import { CustomToolEditorPage } from "~/modules/custom-tools/ui/custom-tool-editor-page.tsx";
import { customToolQuery } from "~/modules/custom-tools/client/queries.ts";

export const Route = createFileRoute("/_app/admin/custom-tools/$toolId")({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(customToolQuery(params.toolId)),
  component: CustomToolRoute,
});

function CustomToolRoute() {
  const { toolId } = Route.useParams();
  return <CustomToolEditorPage toolId={toolId} />;
}
