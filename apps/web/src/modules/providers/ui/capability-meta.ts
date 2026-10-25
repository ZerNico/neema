import {
  AiBrain01Icon,
  Attachment01Icon,
  Image01Icon,
  ToolsIcon,
  ViewIcon,
} from "@hugeicons/core-free-icons";
import { m } from "~/paraglide/messages.js";

export const CAPABILITY_META = [
  { key: "imageOutput" as const, label: m.providers_capability_image_output, icon: Image01Icon },
  { key: "reasoning" as const, label: m.providers_capability_reasoning, icon: AiBrain01Icon },
  // Native support only: models without it still get tools through the
  // gateway's prompt-based fallback (`hermes-tools.ts`).
  { key: "tools" as const, label: m.providers_capability_tools, icon: ToolsIcon },
  { key: "vision" as const, label: m.providers_capability_vision, icon: ViewIcon },
  { key: "files" as const, label: m.providers_capability_files, icon: Attachment01Icon },
];
