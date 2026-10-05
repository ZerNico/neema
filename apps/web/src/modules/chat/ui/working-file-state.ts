/**
 * One word for a working file's state wherever the transcript shows it. An
 * unpublished file after the answer ended is a draft: it may well be kept, so
 * the label says nothing about saving.
 */
export const workingFileState = (published: boolean, terminal: boolean) =>
  published ? "Published" : terminal ? "Draft" : "Working";
