import type { ComponentProps } from "react";

/**
 * Same geometry as public/favicon.svg, cropped to the glyph and drawn in
 * currentColor so it takes the surrounding text colour.
 */
export function NeemaGlyph(props: ComponentProps<"svg">) {
  return (
    <svg viewBox="10 10 44 44" fill="none" aria-hidden {...props}>
      <path
        d="M42 46V30a10 10 0 0 0-20 0v11.5c0 3-2 5.4-5 6"
        stroke="currentColor"
        strokeWidth={7}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={47.5} cy={17.5} r={3.5} fill="currentColor" />
    </svg>
  );
}
