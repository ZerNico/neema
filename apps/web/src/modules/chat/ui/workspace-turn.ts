import { abortWorkTurn, getWorkTurnReservation, reserveWorkTurn } from "../server/functions.ts";
import type { ConversationMode } from "../schema.ts";
import type { WorkspaceImports } from "~/modules/desktop/client/use-workspace-imports.ts";

export const sendReservedWorkspaceTurn = async (input: {
  conversation:
    | { kind: "new"; id: string; mode: ConversationMode }
    | { kind: "existing"; id: string };
  imports: WorkspaceImports;
  activate: (
    reservationId: string,
    files: ReadonlyArray<string>,
  ) => Promise<{ conversationId: string; assistantMessageId: string }>;
}) => {
  const reservationId = crypto.randomUUID();
  await reserveWorkTurn({ data: { reservationId, conversation: input.conversation } });
  let receipt;
  try {
    receipt = await input.imports.promote(reservationId);
  } catch (error) {
    await abortWorkTurn({ data: { reservationId } }).catch(() => {});
    throw error;
  }
  const files = receipt.files.map((file) => file.finalName);
  let activated: { conversationId: string; assistantMessageId: string };
  try {
    activated = await input.activate(reservationId, files);
  } catch (initialError) {
    let status;
    try {
      status = await getWorkTurnReservation({ data: { reservationId } });
    } catch {
      // The server may have committed. Keep the journal for startup recovery.
      throw initialError;
    }
    if (status.status === "activated" && status.assistantMessageId) {
      activated = {
        conversationId: status.conversationId,
        assistantMessageId: status.assistantMessageId,
      };
    } else if (status.status === "reserved") {
      // Activation is idempotent; one retry resolves a lost response without
      // creating another turn or starting another generation.
      try {
        activated = await input.activate(reservationId, files);
      } catch (retryError) {
        let retryStatus;
        try {
          retryStatus = await getWorkTurnReservation({ data: { reservationId } });
        } catch {
          // The retry may have committed too. Leave recovery evidence intact.
          throw retryError;
        }
        if (retryStatus.status === "activated" && retryStatus.assistantMessageId) {
          activated = {
            conversationId: retryStatus.conversationId,
            assistantMessageId: retryStatus.assistantMessageId,
          };
        } else {
          if (retryStatus.status === "reserved") {
            try {
              await abortWorkTurn({ data: { reservationId } });
            } catch {
              throw retryError;
            }
          }
          await input.imports.rollback(reservationId).catch(() => {});
          throw retryError;
        }
      }
    } else {
      await input.imports.rollback(reservationId).catch(() => {});
      throw initialError;
    }
  }
  // A failed local cleanup leaves the journal for authenticated recovery. The
  // server turn owns the files now, so they must never be rolled back.
  await input.imports.commit(reservationId).catch(() => {});
  return activated;
};
