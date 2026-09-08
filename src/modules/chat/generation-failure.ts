/** Application-owned terminal failure copy; never render raw provider diagnostics here. */
export const RESPONSE_FAILURES = {
  ResponseFiltered: {
    title: "The model declined this request",
    description:
      "The provider filtered this response. Try rephrasing your request or choosing another model.",
  },
  ResponseError: {
    title: "Couldn’t generate a response",
    description: "The provider could not finish this response. Try again or choose another model.",
  },
  ResponseIncomplete: {
    title: "The response ended unexpectedly",
    description:
      "The provider ended the stream without confirming completion. Try again or choose another model.",
  },
  ResponseEmpty: {
    title: "The model returned no response",
    description:
      "No text or image was returned. Try again, rephrase your request, or choose another model.",
  },
} as const;

export const responseFailureCopy = (error: string | null | undefined) =>
  Object.entries(RESPONSE_FAILURES).find(([code]) => error?.includes(`[${code}]`))?.[1];
