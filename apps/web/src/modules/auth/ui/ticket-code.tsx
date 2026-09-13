import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import { formatTicket } from "~/modules/auth/desktop-ticket.ts";
import { subscribeTicketRedeemed } from "~/modules/auth/ticket-events.ts";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Button } from "~/ui/primitives/button";

/** Whole seconds left before `expiresAt`, re-read once a second. */
function useSecondsLeft(expiresAt: string): number {
  // The clock is the state and the remainder is derived, so a new expiry
  // shows correctly on the render that brings it, not one tick later.
  const [now, setNow] = useState(() => Date.now());
  const deadline = Date.parse(expiresAt);
  useEffect(() => {
    const timer = setInterval(() => {
      const next = Date.now();
      setNow(next);
      if (next >= deadline) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [deadline]);
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

const clock = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

/**
 * A desktop sign-in code as the reader sees it: grouped, copyable, with the
 * time it has left. The sign-in page and the Devices page both show one, so
 * the countdown and the expiry hand-off live here once.
 */
export function TicketCode({
  ticket,
  ticketId,
  expiresAt,
  onRenew,
  renewing,
}: {
  ticket: string;
  ticketId: string;
  expiresAt: string;
  onRenew: () => void;
  renewing: boolean;
}) {
  const seconds = useSecondsLeft(expiresAt);
  const formatted = formatTicket(ticket);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(copyTimer.current), []);
  // Keyed by ticket id: a renewed code starts out unredeemed again.
  const [redeemedId, setRedeemedId] = useState<string | null>(null);
  useEffect(() => subscribeTicketRedeemed(ticketId, () => setRedeemedId(ticketId)), [ticketId]);

  if (redeemedId === ticketId)
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-sm" role="status">
          Signed in on the new device.
        </p>
        <PendingButton variant="outline" pending={renewing} onClick={onRenew}>
          Generate another code
        </PendingButton>
      </div>
    );

  if (seconds === 0)
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-muted-foreground text-sm">This code has expired.</p>
        <PendingButton variant="outline" pending={renewing} onClick={onRenew}>
          Get a new code
        </PendingButton>
      </div>
    );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <code
          data-testid="ticket-code"
          className="bg-muted flex-1 rounded-2xl px-4 py-3 font-mono text-lg tracking-widest select-all"
        >
          {formatted}
        </code>
        <Button
          variant="outline"
          onClick={() => {
            void navigator.clipboard.writeText(formatted).then(() => {
              clearTimeout(copyTimer.current);
              setCopied(true);
              copyTimer.current = setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} strokeWidth={2} />
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="text-muted-foreground text-sm" role="timer">
        Expires in {clock(seconds)}
      </p>
    </div>
  );
}
