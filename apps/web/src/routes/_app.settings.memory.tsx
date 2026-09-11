import { createFileRoute } from "@tanstack/react-router";
import { memoriesQuery, memorySettingsQuery } from "~/modules/memory/client/queries.ts";
import { MemoryPage } from "~/modules/settings/ui/memory-page.tsx";

export const Route = createFileRoute("/_app/settings/memory")({
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(memorySettingsQuery),
      context.queryClient.ensureQueryData(memoriesQuery),
    ]);
  },
  component: MemoryPage,
});
