import { createFileRoute } from "@tanstack/react-router";
import { skillsQuery } from "~/modules/skills/client/queries.ts";
import { SkillsPage } from "~/modules/skills/ui/skills-page.tsx";

export const Route = createFileRoute("/_app/skills/")({
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(skillsQuery);
  },
  component: SkillsPage,
});
