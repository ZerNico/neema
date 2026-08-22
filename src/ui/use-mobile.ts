import * as React from "react";

const MOBILE_BREAKPOINT = 768;

// One media-query list for every subscriber; created lazily so the module can
// still be imported during SSR, where matchMedia does not exist.
let mql: MediaQueryList | undefined;
const query = () => (mql ??= window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`));

const subscribe = (onChange: () => void) => {
  const list = query();
  list.addEventListener("change", onChange);
  return () => list.removeEventListener("change", onChange);
};

export function useIsMobile() {
  return React.useSyncExternalStore(
    subscribe,
    () => query().matches,
    // Server snapshot: no viewport, assume desktop until hydration.
    () => false,
  );
}
