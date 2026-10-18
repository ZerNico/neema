/**
 * The group server functions answer a taken name with a 409, which reaches the
 * client as an Error carrying only the response text. There is no tagged field
 * to check on the client, so the sniffing lives here alone.
 */
export const isConflict = (error: unknown): boolean => {
  if (error instanceof Error) {
    return error.message.includes("409") || /already taken/i.test(error.message);
  }
  return false;
};
