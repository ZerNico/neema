import { createContext } from "react";

/** Sends a comment on a file as a message to the chat; false when it could not go now. */
export type SendFileComment = (message: string) => Promise<boolean>;

/**
 * The chat a file was shown in, for comments on it. Null outside a chat's
 * messages: a project page, a skill, or the composer's unsent files, which the
 * model cannot read yet.
 */
export const FileCommentContext = createContext<SendFileComment | null>(null);
