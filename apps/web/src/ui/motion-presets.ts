export const motionEase = [0.22, 1, 0.36, 1] as const;

const buildCollapse = (reduced: boolean, axis: "height" | "width") => {
  const closed = { opacity: 0, overflow: "hidden" } as const;
  // Not a transitionEnd: Motion skipped it for an enter interrupted by a
  // re-render (a chip picked from the # list), leaving the row clipping the
  // chips' shadows at rest. Growing in faded from 0 does not need the clip.
  const open = { opacity: 1, overflow: "visible" } as const;
  const vertical = axis === "height";
  return {
    initial: vertical ? { ...closed, height: 0 } : { ...closed, width: 0 },
    animate: vertical ? { ...open, height: "auto" } : { ...open, width: "auto" },
    exit: vertical ? { ...closed, height: 0 } : { ...closed, width: 0 },
    transition: reduced ? { duration: 0 } : { duration: 0.2, ease: motionEase },
  };
};
const collapsePresets = {
  height: { still: buildCollapse(false, "height"), reduced: buildCollapse(true, "height") },
  width: { still: buildCollapse(false, "width"), reduced: buildCollapse(true, "width") },
};

/**
 * Enter and exit for an item inside `AnimatePresence` whose neighbours should
 * close the gap rather than jump. `MotionConfig`'s reduced motion only drops
 * transforms, so size is switched off here. Only the exit clips, as it shrinks;
 * a resting item may hold focus rings, shadows or an attached popover.
 */
export const collapseMotion = (reduced: boolean, axis: "height" | "width" = "height") =>
  collapsePresets[axis][reduced ? "reduced" : "still"];
