import type { AppUseUpdate } from "@chat/desktop-rpc";
import { PauseIcon, PlayIcon, StopIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import * as motion from "motion/react-m";
import type { CSSProperties } from "react";
import { m } from "~/paraglide/messages.js";
import { Button } from "~/ui/primitives/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";
import { cn } from "~/ui/utils";
import { useAppView, useDesktopAppUse } from "../client/use-app-view.ts";

function BarButton({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: IconSvgElement;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onClick}
            aria-label={label}
            className="text-muted-foreground"
          />
        }
      >
        <HugeiconsIcon icon={icon} strokeWidth={2} />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** A dot that breathes while the chat is acting in an app. */
function LiveDot({ active }: { active: boolean }) {
  return (
    <span aria-hidden className="relative flex size-2 shrink-0">
      {active ? (
        <span className="bg-primary absolute inline-flex size-full rounded-full opacity-60 motion-safe:animate-ping" />
      ) : null}
      <span
        className={cn(
          "relative inline-flex size-2 rounded-full",
          active ? "bg-primary" : "bg-muted-foreground/50",
        )}
      />
    </span>
  );
}

/**
 * The row under the tab strip: what is happening, and the person's say over it, as media
 * controls so the line keeps its room in a narrow panel. Pause holds the chat's app use; Stop
 * ends the answer, as the composer's does.
 */
export function AppViewBar({
  conversationId,
  stop,
}: {
  conversationId: string;
  stop: (() => void) | undefined;
}) {
  const appUse = useDesktopAppUse();
  const view = useAppView(conversationId);
  if (!appUse || !view) return null;
  const active = view.live && !view.paused;
  return (
    <div className="flex h-8 items-center gap-1 pl-2 text-sm">
      <LiveDot active={active} />
      <span role="status" className="ml-1 min-w-0 flex-1 truncate" title={view.label}>
        {view.label}
      </span>
      {view.live || view.paused ? (
        <BarButton
          label={view.paused ? m.app_view_resume() : m.app_view_pause()}
          icon={view.paused ? PlayIcon : PauseIcon}
          onClick={() => void appUse.pause(conversationId, !view.paused)}
        />
      ) : null}
      {stop ? <BarButton label={m.app_view_stop()} icon={StopIcon} onClick={stop} /> : null}
    </div>
  );
}

/**
 * The app's window as the chat last saw it, refreshed a few times a second while it acts, with
 * a ring where it last clicked. The picture keeps its shape within the tab: its box is as wide
 * as the tab allows and as tall as its proportions say, both bounded by the stage.
 */
export function AppViewStage({ conversationId }: { conversationId: string }) {
  const appUse = useDesktopAppUse();
  const view = useAppView(conversationId);
  if (!appUse || !view) return null;
  const frame = view.frame;
  const ratio = frame ? frame.width / frame.height : 1;
  return (
    <div
      className="bg-muted/40 relative flex min-h-0 flex-1 items-center justify-center p-4"
      style={{ containerType: "size" } as CSSProperties}
    >
      {frame ? (
        <div
          className="relative"
          style={{
            width: `min(100cqw, calc(100cqh * ${ratio}))`,
            aspectRatio: String(ratio),
          }}
        >
          <img
            src={`data:image/png;base64,${frame.data}`}
            alt={m.app_view_preview({ app: view.app || m.app_view_tab() })}
            // The window's own outline casts the shadow, rounded corners and all.
            className="block size-full drop-shadow-md select-none"
            draggable={false}
          />
          {view.click ? <ClickMark click={view.click} /> : null}
        </div>
      ) : (
        <div className="text-muted-foreground flex flex-col items-center gap-3 text-sm">
          <span className="bg-muted size-24 rounded-lg motion-safe:animate-pulse" />
          {m.app_view_waiting()}
        </div>
      )}
      {view.paused ? <PausedShade conversationId={conversationId} /> : null}
    </div>
  );
}

/** A ring where the last click landed, with a ripple each time it lands anew. */
function ClickMark({ click }: { click: NonNullable<AppUseUpdate["click"]> }) {
  const at = { left: `${click.x * 100}%`, top: `${click.y * 100}%` };
  return (
    <span aria-hidden className="pointer-events-none absolute" style={at}>
      {/* Two rings, light in dark, so it shows on any app's colours. */}
      <span className="border-background ring-primary absolute -top-2.5 -left-2.5 size-5 rounded-full border-2 ring-2" />
      <motion.span
        key={click.at}
        className="border-primary absolute -top-2.5 -left-2.5 size-5 rounded-full border-2"
        initial={{ scale: 0.4, opacity: 0.9 }}
        animate={{ scale: 2.4, opacity: 0 }}
        transition={{ duration: 0.7, ease: "easeOut" }}
      />
    </span>
  );
}

function PausedShade({ conversationId }: { conversationId: string }) {
  const appUse = useDesktopAppUse();
  return (
    <div className="bg-background/75 absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center backdrop-blur-[2px]">
      <p className="text-sm font-medium">{m.app_view_paused()}</p>
      <p className="text-muted-foreground max-w-60 text-xs">{m.app_view_paused_detail()}</p>
      <Button type="button" size="sm" onClick={() => void appUse?.pause(conversationId, false)}>
        <HugeiconsIcon icon={PlayIcon} strokeWidth={2} />
        {m.app_view_resume()}
      </Button>
    </div>
  );
}
