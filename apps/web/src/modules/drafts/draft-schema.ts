import { Schema } from "effect";

/** The kinds of things a chat can author through a draft. */
export const DraftKind = Schema.Literals(["agent", "schedule"]);
export type DraftKind = typeof DraftKind.Type;

/**
 * A draft's row shape, settings left opaque: each kind's service decodes its
 * own payload, so a corrupt row fails that kind's reads, not the table's.
 * `targetId`/`targetRevision` are identity snapshots of the agent or schedule
 * being edited; `savedDraftRevision` is the save receipt.
 */
export interface ConversationDraft<S = unknown> {
  id: string;
  conversationId: string;
  kind: DraftKind;
  settings: S;
  revision: number;
  targetId: string | null;
  targetRevision: number | null;
  savedDraftRevision: number | null;
  createdAt: string;
  updatedAt: string;
}

export class DraftNotAvailable extends Schema.TaggedError<DraftNotAvailable>()(
  // Whichever identity the caller had: creation knows only the conversation.
  "DraftNotAvailable",
  {
    draftId: Schema.optionalKey(Schema.String),
    conversationId: Schema.optionalKey(Schema.String),
  },
) {}
export class DraftRejected extends Schema.TaggedError<DraftRejected>()("DraftRejected", {
  reason: Schema.String,
}) {}
