import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { webSearchAvailabilityQuery } from "../client/queries.ts";

/**
 * Per-message search preference, constrained by the admin config. The model
 * never matters: models without native tool calling are polyfilled in the
 * gateway, so search is offered to all of them alike.
 */
export function useSearchMode() {
  const { data: availability } = useQuery(webSearchAvailabilityQuery);
  const [preferred, setPreferred] = useState(true);
  const eligible = availability?.enabled ?? false;

  return {
    enabled: preferred && eligible,
    setEnabled: setPreferred,
    reset: () => setPreferred(true),
  };
}
