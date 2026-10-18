/**
 * A refused server function reaches the client as an Error carrying only the
 * response text, so a taken group name is known by its wording, here alone.
 */
export const isConflict = (error: unknown): boolean => {
  if (error instanceof Error) {
    return /already taken/i.test(error.message);
  }
  return false;
};
