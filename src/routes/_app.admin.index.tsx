import { createFileRoute } from "@tanstack/react-router";
import {
  modelsQuery,
  ProvidersPanel,
  providersQuery,
} from "~/modules/admin/ui/providers-panel.tsx";

export const Route = createFileRoute("/_app/admin/")({
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(providersQuery),
      context.queryClient.ensureQueryData(modelsQuery),
    ]);
  },
  component: ProvidersPanel,
});
