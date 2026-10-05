import {
  AiBrain01Icon,
  Attachment01Icon,
  Image01Icon,
  ToolsIcon,
  ViewIcon,
} from "@hugeicons/core-free-icons";

export const CAPABILITY_META = [
  { key: "imageOutput" as const, label: "Image generation", icon: Image01Icon },
  { key: "reasoning" as const, label: "Reasoning", icon: AiBrain01Icon },
  // Native support only: models without it still get tools through the
  // gateway's prompt-based fallback (`hermes-tools.ts`).
  { key: "tools" as const, label: "Native tool calling", icon: ToolsIcon },
  { key: "vision" as const, label: "Vision", icon: ViewIcon },
  { key: "files" as const, label: "File input", icon: Attachment01Icon },
];
