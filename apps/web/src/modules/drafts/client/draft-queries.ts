import { queryOptions } from "@tanstack/react-query";
import type { ConversationDraft, DraftKind } from "../draft-schema.ts";

/** The same key `draft.changed` invalidates: `["drafts", kind, draftId]`. */
export const draftQuery = <S>(
  kind: DraftKind,
  draftId: string,
  fetch: (draftId: string) => Promise<ConversationDraft<S> | null>,
) =>
  queryOptions({
    queryKey: ["drafts", kind, draftId] as const,
    queryFn: () => fetch(draftId),
    // Tools write drafts mid-generation; a stale copy would fight the widget.
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
