import {
  Book02Icon,
  BriefcaseIcon,
  ChartIcon,
  PenTool03Icon,
  Robot01Icon,
  Search01Icon,
  SourceCodeIcon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import type { AgentIcon } from "~/modules/agents/schema.ts";

/** Icon identifiers are an app-side set; never a URL. */
export const AGENT_ICONS: Record<AgentIcon, IconSvgElement> = {
  robot: Robot01Icon,
  sparkles: SparklesIcon,
  code: SourceCodeIcon,
  book: Book02Icon,
  search: Search01Icon,
  pen: PenTool03Icon,
  chart: ChartIcon,
  briefcase: BriefcaseIcon,
};
export const agentIcon = (icon: string): IconSvgElement =>
  AGENT_ICONS[icon as AgentIcon] ?? Robot01Icon;
