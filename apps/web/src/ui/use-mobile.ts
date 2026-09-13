import * as React from "react";

const MOBILE_BREAKPOINT = 768;

// One media-query list for every subscriber, created lazily so importing the
// module never touches `window`. A jsdom test can import it with no viewport.
let mql: MediaQueryList | undefined;
// Undefined wherever matchMedia is missing, which in practice is a jsdom test
// that has no reason to care about the viewport. Callers then see "not mobile".
const query = () =>
  (mql ??=
    typeof window === "undefined" || typeof window.matchMedia !== "function"
      ? undefined
      : window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`));

const subscribe = (onChange: () => void) => {
  const list = query();
  list?.addEventListener("change", onChange);
  return () => list?.removeEventListener("change", onChange);
};

export function useIsMobile() {
  return React.useSyncExternalStore(
    subscribe,
    () => query()?.matches ?? false,
    // Unused in the browser: routes mount below the shell's client-only
    // boundary, so the client snapshot is what every caller actually reads.
    () => false,
  );
}
