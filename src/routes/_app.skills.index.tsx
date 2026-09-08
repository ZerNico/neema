import { createFileRoute } from "@tanstack/react-router";
import { SkillsPage } from "~/modules/skills/ui/skills-page.tsx";
export const Route = createFileRoute("/_app/skills/")({ component: SkillsPage });
