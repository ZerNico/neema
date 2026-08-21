import { createFileRoute } from "@tanstack/react-router";
import { MemoryPage } from "~/modules/settings/ui/memory-page.tsx";

export const Route = createFileRoute("/_app/settings/memory")({
  component: MemoryPage,
});
