import { JobError } from "../../server/job-worker.ts";

/** A Word file failure the model or a preview can be told about: `code` is stable, `message` is for readers. */
export class WordError extends JobError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "WordError";
  }
}
