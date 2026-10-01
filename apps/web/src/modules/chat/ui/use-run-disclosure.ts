import { useEffect, useState } from "react";

// Long enough to bridge the gap between one call finishing and the next starting.
const COLLAPSE_DELAY_MS = 800;

/**
 * How a row for a run of calls opens: while `active` (a call running, or the
 * row still the newest part of a streaming answer, so it does not close while
 * the model decides its next call) and a moment after. A manual choice applies
 * to its phase, and a collapse made while active survives the finish.
 */
export function useRunDisclosure(active: boolean) {
  const [previousActive, setPreviousActive] = useState(active);
  const [graceOpen, setGraceOpen] = useState(active);
  if (previousActive !== active) {
    setPreviousActive(active);
    if (active) setGraceOpen(true);
  }
  useEffect(() => {
    if (active || !graceOpen) return;
    const timeout = window.setTimeout(() => setGraceOpen(false), COLLAPSE_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [active, graceOpen]);
  const [override, setOverride] = useState<{ during: boolean; value: boolean } | null>(null);
  const manuallyCollapsedWhileActive =
    override?.during === true && override.value === false && !active;
  const expanded =
    override !== null && override.during === active
      ? override.value
      : manuallyCollapsedWhileActive
        ? false
        : active || graceOpen;
  return {
    expanded,
    onOpenChange: (next: boolean) => setOverride({ during: active, value: next }),
  };
}
