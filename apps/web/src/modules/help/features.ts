import {
  Book02Icon,
  Brain02Icon,
  Calendar03Icon,
  FolderLibraryIcon,
  Robot01Icon,
} from "@hugeicons/core-free-icons";
import type { HugeiconsIcon } from "@hugeicons/react";
import type { ComponentProps } from "react";
import type { Capabilities, Capability } from "~/modules/groups/server/policy.ts";
import { m } from "~/paraglide/messages.js";

export interface Feature {
  /** Stored once seen; never rename a shipped key, or everyone sees it again. */
  key: string;
  capability: Capability;
  createCapability?: Capability;
  useBody?: string;
  icon: ComponentProps<typeof HugeiconsIcon>["icon"];
  title: string;
  summary: string;
  body: string;
  /** One concrete case, so the idea lands without having to picture it. */
  example: string;
  href: "/agents" | "/knowledge" | "/skills" | "/schedules" | "/settings/memory";
  /** The link's words, naming the place it opens. */
  open: string;
}

type Words = "useBody" | "title" | "summary" | "body" | "example" | "open";

/**
 * A feature as the registry holds it: its words as messages, read only where a
 * page shows them, since the server imports this list for its keys alone.
 */
type FeatureEntry = Omit<Feature, Words> & {
  useBody?: () => string;
} & Record<Exclude<Words, "useBody">, () => string>;

/**
 * Every concept someone meets in the app, in plain words. The welcome tour, the
 * "New in neema" tour and the Help page all read this list, so adding a feature
 * here is all it takes for existing users to be told about it once.
 */
const FEATURES: readonly FeatureEntry[] = [
  {
    key: "agents",
    capability: "agentsUse",
    createCapability: "agentsCreate",
    useBody: m.help_agents_use_body,
    icon: Robot01Icon,
    title: m.help_agents_title,
    summary: m.help_agents_summary,
    body: m.help_agents_body,
    example: m.help_agents_example,
    href: "/agents",
    open: m.help_agents_open,
  },
  {
    key: "knowledge",
    capability: "knowledgeUse",
    createCapability: "knowledgeCreate",
    useBody: m.help_knowledge_use_body,
    icon: FolderLibraryIcon,
    title: m.help_knowledge_title,
    summary: m.help_knowledge_summary,
    body: m.help_knowledge_body,
    example: m.help_knowledge_example,
    href: "/knowledge",
    open: m.help_knowledge_open,
  },
  {
    key: "skills",
    capability: "skillsUse",
    createCapability: "skillsCreate",
    useBody: m.help_skills_use_body,
    icon: Book02Icon,
    title: m.help_skills_title,
    summary: m.help_skills_summary,
    body: m.help_skills_body,
    example: m.help_skills_example,
    href: "/skills",
    open: m.help_skills_open,
  },
  {
    key: "schedules",
    capability: "schedules",
    icon: Calendar03Icon,
    title: m.help_schedules_title,
    summary: m.help_schedules_summary,
    body: m.help_schedules_body,
    example: m.help_schedules_example,
    href: "/schedules",
    open: m.help_schedules_open,
  },
  {
    key: "memory",
    capability: "memory",
    icon: Brain02Icon,
    title: m.help_memory_title,
    summary: m.help_memory_summary,
    body: m.help_memory_body,
    example: m.help_memory_example,
    href: "/settings/memory",
    open: m.help_memory_open,
  },
];

export const FEATURE_KEYS = FEATURES.map((feature) => feature.key);

export const availableFeatures = (capabilities: Capabilities): Feature[] =>
  FEATURES.filter((feature) => capabilities[feature.capability]).map((feature) => ({
    key: feature.key,
    capability: feature.capability,
    ...(feature.createCapability ? { createCapability: feature.createCapability } : {}),
    icon: feature.icon,
    href: feature.href,
    title: feature.title(),
    summary: feature.summary(),
    body: (feature.createCapability && !capabilities[feature.createCapability]
      ? (feature.useBody ?? feature.body)
      : feature.body)(),
    example: feature.example(),
    open: feature.open(),
  }));

/** What a person hasn't been shown yet, in the registry's order. */
export const unseenFeatures = <T extends { key: string }>(
  seen: readonly string[],
  features: readonly T[],
) => {
  const known = new Set(seen);
  return features.filter((feature) => !known.has(feature.key));
};
