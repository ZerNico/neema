import { createFileRoute } from "@tanstack/react-router";
import { SkillEditorPage } from "~/modules/skills/ui/skill-editor-page.tsx";
export const Route = createFileRoute("/_app/skills/$skillId")({ component: SkillRoute });
function SkillRoute() {
  const { skillId } = Route.useParams();
  return <SkillEditorPage skillId={skillId} />;
}
