import { createFileRoute } from "@tanstack/react-router";
import { SkillEditorPage } from "~/modules/skills/ui/skill-editor-page.tsx";
export const Route = createFileRoute("/_app/skills/new")({ component: () => <SkillEditorPage /> });
