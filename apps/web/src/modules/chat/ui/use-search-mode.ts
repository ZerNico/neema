import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { composerAvailabilityQuery } from "../client/queries.ts";

/**
 * Per-message search preference, constrained by the admin config. The model
 * never matters: models without native tool calling are polyfilled in the
 * gateway, so search is offered to all of them alike.
 *
 * `defaultEnabled` is what a fresh message starts from and what `reset`
 * returns to: true in plain chat, the agent's own "web search by default" in
 * an agent conversation. A per-message opt-out never outlives the send.
 */
export function useSearchMode(defaultEnabled = true) {
  const { data: availability } = useQuery({
    ...composerAvailabilityQuery,
    select: (available) => available.search,
  });
  const [preferred, setPreferred] = useState<boolean | null>(null);
  const eligible = availability?.enabled ?? false;

  return {
    enabled: (preferred ?? defaultEnabled) && eligible,
    preferred,
    setEnabled: setPreferred,
    reset: () => setPreferred(null),
  };
}
