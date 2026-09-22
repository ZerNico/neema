import { createFileRoute } from "@tanstack/react-router";
import {
  CustomToolEditorPage,
  customToolQuery,
} from "~/modules/custom-tools/ui/custom-tool-editor-page.tsx";

export const Route = createFileRoute("/_app/admin/custom-tools/$toolId")({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(customToolQuery(params.toolId)),
  component: CustomToolRoute,
});

function CustomToolRoute() {
  const { toolId } = Route.useParams();
  return <CustomToolEditorPage toolId={toolId} />;
}
