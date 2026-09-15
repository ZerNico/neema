import { toast } from "sonner";
import {
  desktopAttemptFields,
  folderUsable,
  requireWorkFolder,
  useFolder,
  WORK_FOLDER_UNAVAILABLE,
} from "./bridge.ts";

/**
 * The view's Work gate. One folder query, one `readOnly`, one toasting check,
 * one attempt payload. ChatView and NewChatView both consume this so the
 * composer is told `readOnly` rather than computing the same thing again.
 *
 * `working` is the chat's mode; a first send can pass a different value into
 * `check` / `attemptFields` when the person flipped Work after pressing
 * Submit and an upload is still settling.
 */
export function useWorkGate(conversationId: string, working: boolean) {
  const folder = useFolder(conversationId);
  const readOnly = working && !folderUsable(folder);
  const check = (nowWorking = working) => {
    if (nowWorking && !folderUsable(folder)) {
      toast.error(WORK_FOLDER_UNAVAILABLE);
      throw new Error("Work folder status unavailable");
    }
  };
  const attemptFields = (nowWorking = working) =>
    desktopAttemptFields(requireWorkFolder(nowWorking, folder));
  return { folder, readOnly, check, attemptFields };
}
