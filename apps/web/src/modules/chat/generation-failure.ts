/** Application-owned terminal failure copy; never render raw provider diagnostics here. */
export const RESPONSE_FAILURES = {
  ResponseFiltered: {
    title: "The model declined this request",
    description: "Try rephrasing it, or choose another model.",
  },
  ResponseError: {
    title: "Couldn’t generate a response",
    description: "Try again, or choose another model.",
  },
  ResponseIncomplete: {
    title: "The response stopped partway",
    description: "Try again, or choose another model.",
  },
  ResponseEmpty: {
    title: "The model returned nothing",
    description: "Try again, or choose another model.",
  },
} as const;

export const responseFailureCopy = (error: string | null | undefined) =>
  Object.entries(RESPONSE_FAILURES).find(([code]) => error?.includes(`[${code}]`))?.[1];
