import { useSyncExternalStore } from "react";

const reducedMotionQuery = "(prefers-reduced-motion: reduce)";
export const prefersReducedMotion = () =>
  typeof window !== "undefined" && (window.matchMedia?.(reducedMotionQuery).matches ?? false);
const serverReducedMotion = () => false;
const subscribeReducedMotion = (notify: () => void) => {
  const query = typeof window !== "undefined" ? window.matchMedia?.(reducedMotionQuery) : undefined;
  query?.addEventListener("change", notify);
  return () => query?.removeEventListener("change", notify);
};

export const useAppReducedMotion = () =>
  useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion, serverReducedMotion);
