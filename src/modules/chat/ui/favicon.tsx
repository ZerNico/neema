import { GlobalSearchIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { cn } from "~/ui/utils";

export const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

// Favicon via Google's s2 service — no extra fetch/persistence on our side and
// it gracefully serves a globe placeholder for unknown hosts. Note this reveals
// the visited host to a third party; swap the src if that matters.
export function Favicon({ url, className }: { url: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <HugeiconsIcon
        icon={GlobalSearchIcon}
        className={cn("text-muted-foreground size-4 shrink-0", className)}
      />
    );
  }
  return (
    <img
      src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostOf(url))}&sz=32`}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      className={cn("size-4 shrink-0 rounded-[4px]", className)}
    />
  );
}
