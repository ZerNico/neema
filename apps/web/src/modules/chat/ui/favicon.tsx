import { GlobalSearchIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { cn } from "~/ui/utils";
import { hostOf } from "./host-of.ts";

/**
 * Favicon via our own /api/favicon proxy: the browser never contacts a third
 * party, and the route falls back to 404 (→ the globe icon below) when the
 * upstream has nothing.
 */
export function Favicon({ url, className }: { url: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <HugeiconsIcon
        icon={GlobalSearchIcon}
        strokeWidth={2}
        className={cn("text-muted-foreground size-4 shrink-0", className)}
      />
    );
  }
  return (
    <img
      src={`/api/favicon?domain=${encodeURIComponent(hostOf(url))}`}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      className={cn("size-4 shrink-0 rounded-sm", className)}
    />
  );
}
