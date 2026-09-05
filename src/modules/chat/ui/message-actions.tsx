import {
  ArrowReloadHorizontalIcon,
  BookOpen01Icon,
  Copy01Icon,
  GitBranchIcon,
  MoreHorizontalIcon,
  PencilEdit02Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { chatModelsQuery } from "../client/queries.ts";
import { ModelPicker } from "./model-picker.tsx";
import type { ToolSource } from "../client/use-message-stream.ts";
import type { MessageTime } from "./timestamps.ts";
import { stripCitationMarkers } from "../citation-markers.ts";
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
  disabled = false,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
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
            disabled={disabled}
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

// The retry button is a menu, not a split control: it always opens with
// "Retry same" pinned on top and the model list underneath, so both paths
// share one target (the t3.chat pattern).
//
// Deliberately not useSuspenseQuery: the composer already suspends on this
// list, so the cache is warm by the time the menu opens — and a message row
// that suspends would blank the conversation around it.
function RetryMenu({
  onRetry,
  onRetryWith,
  retryModelId,
  disabled,
}: {
  onRetry: () => void;
  onRetryWith: (modelId: string) => void;
  retryModelId?: string | null | undefined;
  disabled: boolean;
}) {
  const { data: models } = useQuery(chatModelsQuery);

  return (
    <Tooltip>
      <ModelPicker
        models={models ?? []}
        // Marks whichever model wrote the answer being replaced, so "same
        // again" and "something else" are one glance apart in the list too.
        value={retryModelId}
        onChange={onRetryWith}
        disabled={disabled}
        side="bottom"
        emptyLabel={models === undefined ? "Loading models…" : "No models match"}
        header={({ close }) => (
          <div className="p-1.5 pb-0">
            <button
              type="button"
              className="hover:bg-accent hover:text-accent-foreground flex w-full cursor-default items-center gap-2.5 rounded-2xl px-3 py-2 text-sm font-medium select-none [&_svg]:size-4 [&_svg]:shrink-0"
              onClick={() => {
                close();
                onRetry();
              }}
            >
              <HugeiconsIcon icon={ArrowReloadHorizontalIcon} />
              Retry same
            </button>
            <div
              className="text-muted-foreground my-1 flex items-center gap-2 px-2 text-xs"
              role="separator"
            >
              <span className="bg-border h-px flex-1" />
              or switch model
              <span className="bg-border h-px flex-1" />
            </div>
          </div>
        )}
        trigger={
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Retry"
                disabled={disabled}
                // The trigger primitive appends its own chevron; on an
                // icon-sized button the retry glyph alone is the affordance.
                className="text-muted-foreground [&>svg:last-child]:hidden"
              />
            }
          />
        }
      >
        <HugeiconsIcon icon={ArrowReloadHorizontalIcon} className="size-4" />
      </ModelPicker>
      <TooltipContent>Retry</TooltipContent>
    </Tooltip>
  );
}

function RetryControl({
  onRetry,
  onRetryWith,
  retryModelId,
  disabled,
}: {
  onRetry: () => void;
  onRetryWith?: ((modelId: string) => void) | undefined;
  retryModelId?: string | null | undefined;
  disabled: boolean;
}) {
  // No model switch wired (e.g. the caller has no models to offer) — the
  // button degrades to a plain immediate retry.
  if (!onRetryWith) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Retry"
              onClick={onRetry}
              disabled={disabled}
              className="text-muted-foreground"
            />
          }
        >
          <HugeiconsIcon icon={ArrowReloadHorizontalIcon} className="size-4" />
        </TooltipTrigger>
        <TooltipContent>Retry</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <RetryMenu
      onRetry={onRetry}
      onRetryWith={onRetryWith}
      retryModelId={retryModelId}
      disabled={disabled}
    />
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

// The action row under a finished assistant message: copy + retry (with its
// model chevron) always, plus a 3-dot menu (currently just "View sources")
// when there are sources.
export function MessageActions({
  messageId,
  content,
  sources,
  time,
  onEdit,
  editDisabled,
  onBranch,
  branchDisabled,
  onRetry,
  onRetryWith,
  retryModelId,
  retryDisabled,
  timeFirst = false,
  className,
}: {
  messageId: string;
  content: string;
  sources: ToolSource[];
  /** Local send time. Absent until hydration — the server has no timezone. */
  time?: MessageTime | null | undefined;
  /**
   * Leads with the time instead of closing with it. User bubbles are
   * right-aligned, so their row reads inward: time, then the actions.
   */
  timeFirst?: boolean;
  /** Absent for messages that cannot be edited. */
  onEdit?: (() => void) | undefined;
  editDisabled?: boolean;
  /** Fork the conversation at this message. Absent hides the action. */
  onBranch?: (() => void) | undefined;
  branchDisabled?: boolean;
  /** Absent when nothing can be regenerated from this message. */
  onRetry?: (() => void) | undefined;
  /** Regenerate with a different model. Absent hides the model chevron. */
  onRetryWith?: ((modelId: string) => void) | undefined;
  /** Model that produced the response a retry would replace, if still known. */
  retryModelId?: string | null | undefined;
  retryDisabled?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard.writeText(stripCitationMarkers(content)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const stamp = time ? (
    <Tooltip>
      {/* Not a TooltipTrigger button: a focus stop per message would clog
          keyboard navigation for something purely supplementary. The
          visible clock time is what screen readers get. */}
      <TooltipTrigger
        render={
          <time
            dateTime={time.iso}
            className={cn(
              "text-muted-foreground shrink-0 text-2xs leading-[inherit] tabular-nums",
              timeFirst ? "mr-0.5" : "ml-0.5",
            )}
          />
        }
        tabIndex={-1}
      >
        {time.clock}
      </TooltipTrigger>
      <TooltipContent>{time.absolute}</TooltipContent>
    </Tooltip>
  ) : null;

  return (
    <div className={cn("mt-2 flex items-center gap-1", className)}>
      {timeFirst ? stamp : null}
      <ActionButton label={copied ? "Copied" : "Copy"} onClick={copy}>
        <HugeiconsIcon
          icon={copied ? Tick02Icon : Copy01Icon}
          className={copied ? "size-4 text-success" : "size-4"}
        />
      </ActionButton>
      {onEdit ? (
        <ActionButton label="Edit" onClick={onEdit} disabled={editDisabled ?? false}>
          <HugeiconsIcon icon={PencilEdit02Icon} className="size-4" />
        </ActionButton>
      ) : null}
      {onBranch ? (
        <ActionButton label="Branch off" onClick={onBranch} disabled={branchDisabled ?? false}>
          <HugeiconsIcon icon={GitBranchIcon} className="size-4" />
        </ActionButton>
      ) : null}
      {onRetry ? (
        <RetryControl
          onRetry={onRetry}
          onRetryWith={onRetryWith}
          retryModelId={retryModelId}
          disabled={retryDisabled ?? false}
        />
      ) : null}
      {sources.length > 0 ? <SourcesMenu messageId={messageId} sources={sources} /> : null}
      {timeFirst ? null : stamp}
    </div>
  );
}
