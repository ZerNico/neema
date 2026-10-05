import { HugeiconsIcon } from "@hugeicons/react";
import type { ModelCapabilities } from "../model-config.ts";
import { cn } from "~/ui/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";
import { CAPABILITY_META } from "./capability-meta.ts";

export type Capabilities = ModelCapabilities;

/** Compact icon row for a model's capabilities (picker, admin lists). */
export function CapabilityIcons({
  capabilities,
  className,
  audience = "admin",
  details = false,
}: {
  capabilities: Capabilities | null | undefined;
  className?: string;
  audience?: "admin" | "user";
  details?: boolean;
}) {
  if (!capabilities) return null;
  const active = CAPABILITY_META.filter(
    (c) =>
      capabilities[c.key] &&
      (audience === "admin" ||
        c.key === "imageOutput" ||
        c.key === "vision" ||
        c.key === "files" ||
        (details && c.key === "reasoning")),
  );
  if (active.length === 0) return null;
  return (
    <span className={cn("text-muted-foreground flex items-center gap-1", className)}>
      {active.map((meta) => {
        const c =
          audience === "user"
            ? {
                ...meta,
                label:
                  meta.key === "vision"
                    ? "Reads images"
                    : meta.key === "files"
                      ? "Reads files"
                      : meta.label,
              }
            : meta;
        return (
          <Tooltip key={c.key}>
            <TooltipTrigger render={<span role="img" aria-label={c.label} />} tabIndex={-1}>
              <HugeiconsIcon icon={c.icon} strokeWidth={2} className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent>{c.label}</TooltipContent>
          </Tooltip>
        );
      })}
    </span>
  );
}

/** Compact context-length badge, e.g. "128k" or "1M". */
export function ContextBadge({ contextLength }: { contextLength: number | null | undefined }) {
  if (!contextLength) return null;
  const label =
    contextLength >= 1_000_000
      ? `${Math.round(contextLength / 100_000) / 10}M`
      : `${Math.round(contextLength / 1000)}k`;
  return <span className="text-muted-foreground text-xs tabular-nums">{label}</span>;
}
