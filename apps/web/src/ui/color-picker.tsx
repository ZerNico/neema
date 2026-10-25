import { useState, type KeyboardEvent, type PointerEvent } from "react";
import { clamp, hexToHsv, hsvToHex, type Hsv } from "~/ui/color";
import { Input } from "~/ui/primitives/input";
import { cn } from "~/ui/utils";
import { m } from "~/paraglide/messages.js";

/** Where a pointer is across an element, 0 to 1 each way. */
const across = (event: PointerEvent<HTMLElement>) => {
  const box = event.currentTarget.getBoundingClientRect();
  return {
    x: clamp((event.clientX - box.left) / (box.width || 1)),
    y: clamp((event.clientY - box.top) / (box.height || 1)),
  };
};

/**
 * Any colour, picked as most design tools do: brightness and saturation in a
 * square, hue on a strip, or a hex code typed. Dragging shows the colour as
 * it goes and calls `onChange` once, when the pointer lifts, so a sheet gets
 * one change rather than one per pixel. Arrow keys work on both.
 */
export function ColorPicker({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (hex: string) => void;
}) {
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value ?? "") ?? { h: 210, s: 0.7, v: 0.8 });
  const [typed, setTyped] = useState<string | null>(null);
  const hex = hsvToHex(hsv);
  const commit = (next: Hsv) => {
    setHsv(next);
    onChange(hsvToHex(next));
  };
  /** A drag on a control: shown while it moves, committed where it ends. */
  const drag =
    (read: (point: { x: number; y: number }) => Hsv) => (event: PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      setHsv(read(across(event)));
    };
  const square = (point: { x: number; y: number }) => ({ ...hsv, s: point.x, v: 1 - point.y });
  const strip = (point: { x: number }) => ({ ...hsv, h: point.x * 360 });
  const keys = (step: (dx: number, dy: number) => Hsv) => (event: KeyboardEvent<HTMLElement>) => {
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    const size = event.shiftKey ? 10 : 1;
    commit(step(move[0] * size, move[1] * size));
  };
  const typedHsv = typed === null ? null : hexToHsv(typed);
  return (
    <div className="flex flex-col gap-3">
      <div
        role="slider"
        tabIndex={0}
        aria-label={m.ui_color_saturation()}
        aria-valuetext={hex}
        aria-valuenow={Math.round(hsv.s * 100)}
        className="ring-offset-background relative h-28 cursor-crosshair touch-none rounded-md outline-none focus-visible:ring-2"
        // The colour being picked is the control's own content, not a theme colour.
        style={{
          background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent), hsl(${hsv.h} 100% 50%)`,
        }}
        onPointerDown={drag(square)}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) setHsv(square(across(event)));
        }}
        onPointerUp={(event) => commit(square(across(event)))}
        onKeyDown={keys((dx, dy) => ({
          ...hsv,
          s: clamp(hsv.s + dx / 100),
          v: clamp(hsv.v - dy / 100),
        }))}
      >
        <span
          aria-hidden
          className="border-background pointer-events-none absolute size-3.5 -translate-1/2 rounded-full border-2 shadow"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, backgroundColor: hex }}
        />
      </div>
      <div
        role="slider"
        tabIndex={0}
        aria-label={m.ui_color_hue()}
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(hsv.h)}
        className="ring-offset-background relative h-3 cursor-pointer touch-none rounded-full outline-none focus-visible:ring-2"
        style={{
          background: "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)",
        }}
        onPointerDown={drag(strip)}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) setHsv(strip(across(event)));
        }}
        onPointerUp={(event) => commit(strip(across(event)))}
        onKeyDown={keys((dx) => ({ ...hsv, h: (hsv.h + dx + 360) % 360 }))}
      >
        <span
          aria-hidden
          className="border-background pointer-events-none absolute top-1/2 size-3.5 -translate-1/2 rounded-full border-2 shadow"
          style={{ left: `${(hsv.h / 360) * 100}%`, backgroundColor: `hsl(${hsv.h} 100% 50%)` }}
        />
      </div>
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="border-border size-7 shrink-0 rounded-md border"
          style={{ backgroundColor: typedHsv ? hsvToHex(typedHsv) : hex }}
        />
        <Input
          aria-label={m.ui_color_hex()}
          spellCheck={false}
          value={typed ?? hex}
          aria-invalid={typed !== null && !typedHsv}
          className={cn("font-mono uppercase")}
          onChange={(event) => setTyped(event.target.value)}
          onBlur={() => {
            if (typedHsv) commit(typedHsv);
            setTyped(null);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            if (typedHsv) commit(typedHsv);
            setTyped(null);
          }}
        />
      </div>
    </div>
  );
}
