/** A presentation failure the model or a preview can be told about: `code` is stable, `message` is for readers. */
export class PresentationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PresentationError";
    this.code = code;
  }
}
