import { Globe02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect } from "react";
import type { LinkSafetyModalProps } from "streamdown";
import { linkGoesToPanel, openLinkInPanel } from "~/ui/link-opener.ts";
import { Button } from "~/ui/primitives/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/ui/primitives/dialog";
import { m } from "~/paraglide/messages.js";

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/**
 * The question before a link in rendered text leaves the app, asked with the
 * app's own dialog rather than Streamdown's: model text can name one address
 * and link another, so the real one is shown before it opens.
 */
export function LeaveDialog({ isOpen, onClose, onConfirm, url }: LinkSafetyModalProps) {
  // Opening in the side panel does not leave the app, and the panel shows the
  // real address, so there is nothing to ask.
  const inPanel = isOpen && linkGoesToPanel();
  useEffect(() => {
    if (inPanel && openLinkInPanel(url)) onClose();
  }, [inPanel, url, onClose]);
  if (inPanel) return null;
  // A plain dialog, not an alert: opening a link destroys nothing, so a click
  // outside or Escape simply cancels.
  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader className="flex-row items-center gap-3 text-left">
          <span className="bg-muted text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-lg">
            <HugeiconsIcon icon={Globe02Icon} strokeWidth={2} className="size-5" />
          </span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <DialogTitle>{m.ui_leave_title()}</DialogTitle>
            <DialogDescription>{m.ui_leave_description({ host: hostOf(url) })}</DialogDescription>
          </div>
        </DialogHeader>
        <p className="bg-muted text-muted-foreground rounded-lg px-3 py-2 font-mono text-xs break-all">
          {url}
        </p>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>{m.common_cancel()}</DialogClose>
          <Button onClick={onConfirm}>{m.ui_leave_confirm()}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
