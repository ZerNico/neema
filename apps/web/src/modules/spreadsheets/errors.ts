import { JobError } from "../../server/job-worker.ts";

/** A spreadsheet failure the model or a preview can be told about: `code` is stable, `message` is for readers. */
export class SpreadsheetError extends JobError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "SpreadsheetError";
  }
}
