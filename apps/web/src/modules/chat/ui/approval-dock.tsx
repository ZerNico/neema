import { m } from "~/paraglide/messages.js";
import { ArrowLeft01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import type { PendingKind } from "~/modules/desktop/client/approvals.ts";
import type { PendingIntegrationCall } from "~/modules/integrations/schema.ts";
import { ElicitationCard } from "~/modules/integrations/ui/elicitation-card.tsx";
import {
  useDecideIntegrationCall,
  useIntegrationCallNames,
} from "~/modules/integrations/client/use-integration-call.ts";
import { IntegrationApproval } from "~/modules/integrations/ui/integration-activity-block.tsx";
import { Button } from "~/ui/primitives/button";
import { AnimatePresence } from "motion/react";
import * as motion from "motion/react-m";
import { collapseMotion, stepMotion } from "~/ui/motion-presets.ts";
import { useAppReducedMotion } from "~/ui/reduced-motion.ts";
import { HeightMorph } from "~/ui/motion.tsx";
import type { DesktopToolActivity } from "../client/use-message-stream.ts";
import { DesktopApproval, type DesktopApprovalRequest } from "./desktop-activity-block.tsx";
import { focusIsLost } from "./focus-lost.ts";

/** One call parked on the person, in the order the answer made them. */
export type DockApproval =
  | {
      family: "desktop";
      callId: string;
      activity: DesktopToolActivity;
      approval: DesktopApprovalRequest;
    }
  | { family: "integration"; callId: string; call: PendingIntegrationCall };

// Asked one at a time on purpose: what they delete, where they connect or which
// machine they bind differs per call, so a batch would approve what nobody read.
const SINGLE_KINDS: ReadonlySet<PendingKind> = new Set(["delete", "site", "network", "bind"]);

/** The calls one "Allow all" may settle: the same tool, each a plain once-allow. */
const batchOf = (items: ReadonlyArray<DockApproval>) => {
  if (items.length < 2) return null;
  const [first] = items;
  if (first?.family === "desktop") {
    const same = items.every(
      (item) =>
        item.family === "desktop" &&
        item.activity.name === first.activity.name &&
        item.approval.kind === first.approval.kind,
    );
    return same && !SINGLE_KINDS.has(first.approval.kind) ? first : null;
  }
  if (first?.family === "integration") {
    const same = items.every(
      (item) =>
        item.family === "integration" &&
        item.call.kind === "approval" &&
        item.call.integrationId === first.call.integrationId &&
        // Each card names one account; a batch never spans two.
        item.call.connectionId === first.call.connectionId &&
        item.call.tool === first.call.tool &&
        // Contacting people is read call by call: each has its own recipients.
        item.call.access !== "destructive",
    );
    return same ? first : null;
  }
  return null;
};

/**
 * What the composer turns into while the answer is parked on the person. The
 * run can do nothing else until they decide, so the decision is the one thing on
 * offer; the composer's bar keeps Stop, and the draft waits underneath.
 */
export function ApprovalDock({ items }: { items: ReadonlyArray<DockApproval> }) {
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [direction, setDirection] = useState(1);
  // The first call arrives with the composer's own swap; later ones slide in.
  const [firstId] = useState(items[0]?.callId);
  const pagerCollapse = collapseMotion(useAppReducedMotion());
  const section = useRef<HTMLElement>(null);
  // Covering the composer took the caret with it: land on the dock, never on a
  // button, so an Enter meant for the draft cannot allow anything.
  useEffect(() => {
    if (focusIsLost()) section.current?.focus({ preventScroll: true });
  }, []);
  const picked = items.findIndex((item) => item.callId === pickedId);
  // A decided call leaves the list; the next one in line takes its place.
  const index = picked === -1 ? 0 : picked;
  const current = items[index];
  const batch = batchOf(items);
  if (!current) return null;
  // A service's follow-up question on the same call is a new body too.
  const bodyKey =
    current.family === "integration"
      ? `${current.callId}:${current.call.promptId}`
      : current.callId;
  const go = (step: number) => {
    setDirection(step);
    setPickedId(items[(index + step + items.length) % items.length]!.callId);
  };

  return (
    <section
      ref={section}
      tabIndex={-1}
      aria-label={m.chat_dock_approval_label()}
      className="flex max-h-[min(32rem,60dvh)] min-w-0 flex-col gap-3 overflow-x-hidden overflow-y-auto px-4 pt-4 pb-1 outline-none"
    >
      {/* More calls can park while one is shown: the pager opens in, never pops. Its own
          bottom padding stands in for the gap, so at no height it leaves none behind. */}
      <AnimatePresence initial={false}>
        {items.length > 1 ? (
          <motion.div key="pager" {...pagerCollapse} className="-mb-3">
            <div className="text-muted-foreground -mr-2 -mt-1 flex items-center gap-1 pb-3 text-xs">
              <span className="tabular-nums" aria-live="polite">
                {m.chat_dock_position({ index: index + 1, count: items.length })}
              </span>
              <span className="flex-1" />
              {batch ? <AllowAll items={items} /> : null}
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={m.chat_dock_previous()}
                onClick={() => go(-1)}
              >
                <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={m.chat_dock_next()}
                onClick={() => go(1)}
              >
                <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} />
              </Button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
      {/* Paging or a decided call swaps the body; the shell around it stays put. */}
      <HeightMorph swap={bodyKey}>
        <motion.div
          key={bodyKey}
          {...(current.callId !== firstId ? stepMotion(direction) : {})}
          className="min-w-0"
        >
          {current.family === "desktop" ? (
            <DesktopApproval activity={current.activity} approval={current.approval} />
          ) : current.call.kind === "elicitation" && current.call.prompt ? (
            // A new question starts a fresh form, never one filled in for the last.
            <DockElicitation call={current.call} />
          ) : (
            <IntegrationApproval call={current.call} />
          )}
        </motion.div>
      </HeightMorph>
    </section>
  );
}

function DockElicitation({ call }: { call: PendingIntegrationCall }) {
  return <ElicitationCard call={call} name={useIntegrationCallNames(call).name} />;
}

function AllowAll({ items }: { items: ReadonlyArray<DockApproval> }) {
  const decide = useDecideIntegrationCall();
  const [pending, setPending] = useState(false);
  const allow = async () => {
    setPending(true);
    try {
      await Promise.all(
        items.map((item) =>
          item.family === "desktop"
            ? item.approval.decide("allow")
            : decide.mutateAsync({ callId: item.callId, decision: "once" }),
        ),
      );
    } catch {
      // Each failure has its toast; the calls still waiting stay in the dock.
    } finally {
      setPending(false);
    }
  };
  return (
    <Button size="xs" variant="ghost" disabled={pending} onClick={() => void allow()}>
      {m.chat_dock_allow_all({ count: items.length })}
    </Button>
  );
}
