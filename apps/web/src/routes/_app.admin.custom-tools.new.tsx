import { createFileRoute } from "@tanstack/react-router";
import { CustomToolEditorPage } from "~/modules/custom-tools/ui/custom-tool-editor-page.tsx";

export const Route = createFileRoute("/_app/admin/custom-tools/new")({
  component: () => <CustomToolEditorPage />,
});
