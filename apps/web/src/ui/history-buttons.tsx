import { ArrowLeft01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useRouter, type RouterHistory } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useDesktopChromePlatform } from "./desktop-chrome-context.ts";
import { Button } from "./primitives/button";
import { Kbd } from "./primitives/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "./primitives/tooltip";

/**
 * The browser exposes no forward length, so the furthest entry is tracked here:
 * a push truncates everything after it, a pop only moves within the stack.
 * A reload forgets entries ahead of the current one, leaving forward disabled
 * until the user goes back again.
 */
function useHistoryPosition(history: RouterHistory) {
  const [position, setPosition] = useState(() => {
    const index = history.location.state.__TSR_index;
    return { index, top: index };
  });
  useEffect(
    () =>
      history.subscribe(({ action }) => {
        const index = history.location.state.__TSR_index;
        setPosition((current) => ({
          index,
          top: action.type === "PUSH" ? index : Math.max(current.top, index),
        }));
      }),
    [history],
  );
  return { canGoBack: position.index > 0, canGoForward: position.index < position.top };
}

/** A browser already has these, so only the desktop titlebar shows them. */
export function HistoryButtons() {
  const platform = useDesktopChromePlatform();
  return platform ? <DesktopHistoryButtons mac={platform === "darwin"} /> : null;
}

function DesktopHistoryButtons({ mac }: { mac: boolean }) {
  const { history } = useRouter();
  const { canGoBack, canGoForward } = useHistoryPosition(history);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.shiftKey) return;
      // Cmd+[ and Cmd+] on macOS, Alt+Left and Alt+Right elsewhere, as in browsers.
      const back = mac
        ? event.metaKey && event.key === "["
        : event.altKey && event.key === "ArrowLeft";
      const forward = mac
        ? event.metaKey && event.key === "]"
        : event.altKey && event.key === "ArrowRight";
      if (!back && !forward) return;
      event.preventDefault();
      if (back) history.back();
      else history.forward();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [history, mac]);

  // One pair, so the header's gap sits around it rather than between the arrows.
  return (
    <div className="flex items-center">
      <HistoryButton
        label="Back"
        icon={ArrowLeft01Icon}
        shortcut={mac ? "⌘[" : "Alt ←"}
        disabled={!canGoBack}
        onClick={() => history.back()}
      />
      <HistoryButton
        label="Forward"
        icon={ArrowRight01Icon}
        shortcut={mac ? "⌘]" : "Alt →"}
        disabled={!canGoForward}
        onClick={() => history.forward()}
      />
    </div>
  );
}

function HistoryButton({
  label,
  icon,
  shortcut,
  disabled,
  onClick,
}: {
  label: string;
  icon: IconSvgElement;
  shortcut: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        <HugeiconsIcon icon={icon} strokeWidth={2} />
      </TooltipTrigger>
      <TooltipContent>
        {label} <Kbd>{shortcut}</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}
