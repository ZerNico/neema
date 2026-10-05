/** An icon button and the gap after it. */
const SLOT = 34;

/**
 * How many of `total` controls fit in `room` pixels, keeping a slot for More
 * when not all do. Unmeasured (no layout yet, or none at all) shows them all.
 */
export const fittingControls = (room: number, total: number) =>
  room <= 0 || total * SLOT <= room ? total : Math.max(0, Math.floor(room / SLOT) - 1);
