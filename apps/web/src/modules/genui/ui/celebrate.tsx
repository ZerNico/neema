// Confetti for `<celebrate when>`: only when `when` turns true in a tree the
// reader's own click or change produced. A reload's cached tree giving way to
// the live one, a remount, a stream and a Worker restart all change the tree
// too, and none of them is the moment the reader reached the goal. A
// celebrate that appears because of the event counts as turning true.

import * as m from "motion/react-m";
import { use, useState } from "react";
import { useAppReducedMotion } from "~/ui/reduced-motion.ts";
import { ReaderEventContext } from "./context.ts";

const COLOURS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--primary)",
];
const PIECES = 28;

/** Fixed per piece, so the burst is the same every time and rendering stays pure. */
const SPREAD = Array.from({ length: PIECES }, (_, i) => {
  const angle = (i / PIECES) * Math.PI * 2 + (i % 3) * 0.35;
  const reach = 70 + ((i * 37) % 60);
  return {
    x: Math.cos(angle) * reach,
    y: Math.sin(angle) * reach * 0.6 - 30,
    fall: 60 + ((i * 53) % 50),
    rotate: ((i * 97) % 360) - 180,
    colour: COLOURS[i % COLOURS.length],
    round: i % 2 === 0,
  };
});

export function Celebrate({ when }: { when: boolean }) {
  const reduced = useAppReducedMotion();
  const byEvent = use(ReaderEventContext);
  const [seen, setSeen] = useState(byEvent ? false : when);
  const [burst, setBurst] = useState(0);
  if (when !== seen) {
    setSeen(when);
    if (when && byEvent) setBurst((n) => n + 1);
  }
  if (burst === 0 || reduced) return null;
  return (
    <div aria-hidden data-slot="celebrate" className="pointer-events-none relative h-0 self-center">
      {SPREAD.map((piece, i) => (
        <m.span
          // oxlint-disable-next-line react/no-array-index-key -- a piece is its position in the fixed spread; the burst number restarts them
          key={`${burst}-${i}`}
          className={
            piece.round ? "absolute size-2 rounded-full" : "absolute h-2.5 w-1.5 rounded-xs"
          }
          style={{ backgroundColor: piece.colour }}
          initial={{ x: 0, y: 0, rotate: 0, opacity: 1 }}
          animate={{
            x: piece.x,
            y: [0, piece.y, piece.y + piece.fall],
            rotate: piece.rotate,
            opacity: [1, 1, 0],
          }}
          transition={{ duration: 1.2, ease: "easeOut", times: [0, 0.45, 1] }}
        />
      ))}
    </div>
  );
}
