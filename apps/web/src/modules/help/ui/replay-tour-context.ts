import { createContext, useContext } from "react";

export const ReplayContext = createContext<(() => void) | null>(null);

/** Reopens the full tour, for the Help page; seen state is left as it is. */
export function useReplayTour() {
  const replay = useContext(ReplayContext);
  if (!replay) throw new Error("useReplayTour must be used within FeatureTourProvider");
  return replay;
}
