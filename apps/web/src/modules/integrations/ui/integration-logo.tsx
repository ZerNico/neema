import { PlugSocketIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "~/ui/utils";
import { findIntegration } from "../catalog.ts";

/**
 * The one way an integration is identified on screen. `tile` sits in a list
 * row like the other settings icons; `inline` sits in text, chips and tool rows.
 */
export function IntegrationLogo({
  integrationId,
  variant = "inline",
  className,
}: {
  integrationId: string;
  variant?: "inline" | "tile";
  className?: string;
}) {
  const Logo = findIntegration(integrationId)?.logo;
  const mark = Logo ? (
    <Logo className={cn("size-4 shrink-0", variant === "inline" && className)} />
  ) : (
    <HugeiconsIcon
      icon={PlugSocketIcon}
      strokeWidth={2}
      className={cn("size-4 shrink-0", variant === "inline" && className)}
    />
  );
  if (variant === "inline") return mark;
  return (
    <div
      className={cn(
        "bg-muted text-foreground flex size-9 shrink-0 items-center justify-center rounded-2xl",
        className,
      )}
    >
      {mark}
    </div>
  );
}
