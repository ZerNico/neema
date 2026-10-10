import { Schema } from "effect";
import type { SheetDoc } from "@chat/sheet/model";
import { LIVE_LIMITS } from "@chat/sheet/model/limits";
import type { SheetChange } from "@chat/sheet/model/ops";
import { DocumentTitle, type DocumentComment } from "../schema.ts";

export const SHEET_TRANSPORT = {
  /** Changes in one push; an editor batches what it sent while the last push was out. */
  changes: 200,
} as const;

const ResourceId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
/** A new sheet with one empty tab. Exactly one owner: a chat, or a project. */
export const CreateSheetInput = Schema.Struct({
  conversationId: Schema.optionalKey(ResourceId),
  projectId: Schema.optionalKey(ResourceId),
  /** A chat sheet's answer; rewinding past it deletes the sheet. */
  createdByMessageId: Schema.optionalKey(ResourceId),
  title: DocumentTitle,
  /** How its cells are typed and shown, and the clock NOW reads. */
  locale: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(20))),
  timeZone: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
  by: Schema.optionalKey(Schema.Literals(["user", "model"])),
});
export type CreateSheetInput = typeof CreateSheetInput.Type;

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64));
const CellAt = Schema.Struct({ r: Id, c: Id });
/** Where one editor's selection sits, by IDs, so it stays put through inserts. */
export const SheetCursor = Schema.Struct({ sheet: Id, anchor: CellAt, head: CellAt });
export type SheetCursor = typeof SheetCursor.Type;
export interface SheetPresence extends SheetCursor {
  user: { name: string; color: string; colorLight: string };
}

/**
 * A person's sheet editor: changes in its own sequence and/or its cursor.
 * Each change is `JSON.stringify(change)`, checked by `parseChange`.
 */
export const PushSheetInput = Schema.Struct({
  documentId: ResourceId,
  clientId: Id,
  changes: Schema.optionalKey(
    Schema.Array(
      Schema.String.check(Schema.isMinLength(2), Schema.isMaxLength(LIVE_LIMITS.changeBytes)),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(SHEET_TRANSPORT.changes)),
  ),
  cursor: Schema.optionalKey(SheetCursor),
});
export type PushSheetInput = typeof PushSheetInput.Type;

/**
 * `acked` is the client's last sequence number the server has: every pending
 * change up to it is settled, applied or refused. `refused` names the ones
 * that changed nothing, and why.
 */
export interface PushSheetResult {
  revision: number;
  acked: number;
  refused: ReadonlyArray<{ seq: number; reason: string }>;
}

/** What volatile functions read at a revision: the moment as a serial, and a seed. */
export interface SheetMoment {
  now: number;
  seed: number;
}

/** What the live sheet stream sends. */
export type SheetFrame =
  | {
      /** The whole document; `acked` is this client's last sequence number in it. */
      type: "reset";
      doc: SheetDoc;
      revision: number;
      moment: SheetMoment;
      acked: number | null;
    }
  | {
      /** Changes after `revision - changes.length`, in the server's order. */
      type: "changes";
      changes: ReadonlyArray<SheetChange>;
      revision: number;
      moment: SheetMoment;
    }
  | { type: "comments"; comments: ReadonlyArray<DocumentComment> }
  | { type: "presence"; clientId: string; presence: SheetPresence | null }
  | { type: "gone" };
