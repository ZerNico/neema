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

/**
 * Every concept someone meets in the app, in plain words. The welcome tour, the
 * "New in neema" tour and the Help page all read this list, so adding a feature
 * here is all it takes for existing users to be told about it once.
 */
export const FEATURES: readonly Feature[] = [
  {
    key: "agents",
    capability: "agentsUse",
    createCapability: "agentsCreate",
    useBody:
      "Pick an agent when you start a chat to use its instructions, documents and tools. Agents shared with you are ready to use without setting one up yourself.",
    icon: Robot01Icon,
    title: "Agents",
    summary: "Helpers set up for one kind of task.",
    body: "An agent keeps how you want a task done: its instructions, the documents it may look at and the tools it may use. Pick one when you start a chat and it works that way every time.",
    example:
      "A “Contract reviewer” that checks every contract you share against your company’s rules.",
    href: "/agents",
    open: "Open Agents",
  },
  {
    key: "knowledge",
    capability: "knowledgeUse",
    createCapability: "knowledgeCreate",
    useBody:
      "Choose a collection shared with you in a chat. The assistant can look things up in its documents and show where each answer came from.",
    icon: FolderLibraryIcon,
    title: "Knowledge",
    summary: "Your documents, ready to use in chats.",
    body: "Put documents and notes into a collection. In a chat, the assistant can look things up in them and shows which document each answer came from.",
    example:
      "A “Company handbook” collection, so you can ask how many vacation days you have left.",
    href: "/knowledge",
    open: "Open Knowledge",
  },
  {
    key: "skills",
    capability: "skillsUse",
    createCapability: "skillsCreate",
    useBody:
      "A skill is a short set of instructions for one kind of job. Choose a skill shared with you in a chat, or let the assistant pick it up when it fits.",
    icon: Book02Icon,
    title: "Skills",
    summary: "Know-how the assistant picks up when it’s needed.",
    body: "A skill is a short set of instructions for one kind of job, like reviewing a contract. The assistant uses it on its own when it fits, or when you choose it in a chat.",
    example: "A “Meeting notes” skill that turns any transcript into decisions and to-dos.",
    href: "/skills",
    open: "Open Skills",
  },
  {
    key: "schedules",
    capability: "schedules",
    icon: Calendar03Icon,
    title: "Schedules",
    summary: "Tasks that run on their own.",
    body: "Ask for something to happen regularly, like a news summary every weekday at 07:00. Each run starts a new chat, which you can open from the schedule.",
    example: "“Every Monday at 08:00, sum up last week’s news about our industry.”",
    href: "/schedules",
    open: "Open Schedules",
  },
  {
    key: "memory",
    capability: "memory",
    icon: Brain02Icon,
    title: "Memory",
    summary: "Things the assistant remembers about you.",
    body: "The assistant can save small facts you share, like how you like answers written, and use them in later chats. You can see, change or delete them in Settings.",
    example: "“I prefer short answers” is remembered, and every later chat keeps to it.",
    href: "/settings/memory",
    open: "Open Memory",
  },
];

export const FEATURE_KEYS = FEATURES.map((feature) => feature.key);

export const availableFeatures = (capabilities: Capabilities) =>
  FEATURES.filter((feature) => capabilities[feature.capability]).map((feature) => ({
    ...feature,
    body:
      feature.createCapability && !capabilities[feature.createCapability]
        ? (feature.useBody ?? feature.body)
        : feature.body,
  }));

/** What a person hasn't been shown yet, in the registry's order. */
export const unseenFeatures = (
  seen: readonly string[],
  features: readonly Feature[] = FEATURES,
) => {
  const known = new Set(seen);
  return features.filter((feature) => !known.has(feature.key));
};
