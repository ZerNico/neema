/**
 * The group server functions answer a taken name with a bare 409 Response
 * (`Effect.die(new Response(..., { status: 409 }))`), which the server-fn
 * client surfaces as an untyped Error carrying the response text. There is no
 * tagged field to check on the client, so the sniffing lives here alone.
 */
export const isConflict = (error: unknown): boolean => {
  if (error instanceof Response) return error.status === 409;
  if (error instanceof Error) {
    return error.message.includes("409") || /already taken/i.test(error.message);
  }
  return false;
};
