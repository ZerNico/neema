import { useCallback, useEffect, useRef, useState } from "react";

/** How long a Save button says "Saved". */
const SAVED_FOR_MS = 3000;

/** Pairs `SaveLabel` and `SaveStatus`: call `markSaved` when a save lands. */
export function useSaveStatus() {
  const [justSaved, setJustSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const markSaved = useCallback(() => {
    clearTimeout(timer.current);
    setJustSaved(true);
    timer.current = setTimeout(() => setJustSaved(false), SAVED_FOR_MS);
  }, []);
  return { justSaved, markSaved };
}
