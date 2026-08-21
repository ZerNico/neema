import { AiBrain01Icon, ToolsIcon, ViewIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "~/ui/utils";

export interface Capabilities {
  reasoning: boolean;
  tools: boolean;
  vision: boolean;
}

export const CAPABILITY_META = [
  { key: "reasoning" as const, label: "Reasoning", icon: AiBrain01Icon },
  { key: "tools" as const, label: "Tool calling", icon: ToolsIcon },
  { key: "vision" as const, label: "Vision", icon: ViewIcon },
];

// Compact icon row for a model's capabilities (picker, admin lists).
export function CapabilityIcons({
  capabilities,
  className,
}: {
  capabilities: Capabilities | null | undefined;
  className?: string;
}) {
  if (!capabilities) return null;
  const active = CAPABILITY_META.filter((c) => capabilities[c.key]);
  if (active.length === 0) return null;
  return (
    <span className={cn("text-muted-foreground flex items-center gap-1", className)}>
      {active.map((c) => (
        <span key={c.key} title={c.label} aria-label={c.label}>
          <HugeiconsIcon icon={c.icon} className="size-3.5" />
        </span>
      ))}
    </span>
  );
}

// Compact context-length badge, e.g. "128k" or "1M".
export function ContextBadge({ contextLength }: { contextLength: number | null | undefined }) {
  if (!contextLength) return null;
  const label =
    contextLength >= 1_000_000
      ? `${Math.round(contextLength / 100_000) / 10}M`
      : `${Math.round(contextLength / 1000)}k`;
  return <span className="text-muted-foreground text-xs tabular-nums">{label}</span>;
}
