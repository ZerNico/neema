import {
  ArrowReloadHorizontalIcon,
  BookOpen01Icon,
  Copy01Icon,
  MoreHorizontalIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import type { ToolSource } from "../client/use-message-stream.ts";
import { useSourcesPanel } from "./sources-panel.tsx";
import { Button } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";
import { cn } from "~/ui/utils";

function ActionButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            onClick={onClick}
            className="text-muted-foreground"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

// Own component so useSourcesPanel (which needs a DetailPanelProvider) only
// runs for messages that actually have sources.
function SourcesMenu({ messageId, sources }: { messageId: string; sources: ToolSource[] }) {
  const openSources = useSourcesPanel(messageId, sources);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Message actions"
            className="text-muted-foreground"
          />
        }
      >
        <HugeiconsIcon icon={MoreHorizontalIcon} className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onClick={() => openSources()}>
          <HugeiconsIcon icon={BookOpen01Icon} className="size-4" />
          View sources ({sources.length})
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// The action row under a finished assistant message: copy + retry always,
// plus a 3-dot menu (currently just "View sources") when there are sources.
export function MessageActions({
  messageId,
  content,
  sources,
  onRetry,
  retryDisabled,
  className,
}: {
  messageId: string;
  content: string;
  sources: ToolSource[];
  /** Absent when nothing can be regenerated from this message. */
  onRetry?: (() => void) | undefined;
  retryDisabled?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className={cn("mt-2 flex items-center gap-1", className)}>
      <ActionButton label={copied ? "Copied" : "Copy"} onClick={copy}>
        <HugeiconsIcon
          icon={copied ? Tick02Icon : Copy01Icon}
          className={copied ? "size-4 text-emerald-500" : "size-4"}
        />
      </ActionButton>
      {onRetry ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Retry"
                onClick={onRetry}
                disabled={retryDisabled ?? false}
                className="text-muted-foreground"
              />
            }
          >
            <HugeiconsIcon icon={ArrowReloadHorizontalIcon} className="size-4" />
          </TooltipTrigger>
          <TooltipContent>Retry</TooltipContent>
        </Tooltip>
      ) : null}
      {sources.length > 0 ? <SourcesMenu messageId={messageId} sources={sources} /> : null}
    </div>
  );
}
