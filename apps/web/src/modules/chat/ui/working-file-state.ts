import { m } from "~/paraglide/messages.js";
/**
 * One word for a working file's state wherever the transcript shows it. An
 * unpublished file after the answer ended is a draft: it may well be kept, so
 * the label says nothing about saving.
 */
export type WorkingFilePhase = "published" | "draft" | "working";

export const workingFileState = (published: boolean, terminal: boolean): WorkingFilePhase =>
  published ? "published" : terminal ? "draft" : "working";

const LABELS = {
  published: m.chat_working_file_published,
  draft: m.chat_working_file_draft,
  working: m.chat_working_file_working,
};

export const workingFileLabel = (state: WorkingFilePhase) => LABELS[state]();
