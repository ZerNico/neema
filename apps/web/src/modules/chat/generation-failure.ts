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

const FAILURE_DETAIL_PREFIXES = [
  /^ProviderUnreachable:\s*/i,
  /^effect\/ai\/AiError\/AiError:\s*/i,
  /^[A-Za-z][\w]*Client\.[A-Za-z][\w]*:\s*/,
];

/** A provider failure without the wrapping the engine records it in, for a reader to act on. */
export function generationFailureDetails(error: string): string {
  let details = error
    .trim()
    .replace(/^Cause\(\[Fail\(/, "")
    .replace(/\)\]\)$/, "");

  for (const prefix of FAILURE_DETAIL_PREFIXES) {
    details = details.replace(prefix, "");
  }

  return details || error;
}

/** Why an answer failed, in the words the chat shows: the app's own copy, else the provider's reason. */
export const generationFailureReason = (error: string | null | undefined) => {
  if (!error) return null;
  const copy = responseFailureCopy(error);
  return copy ? `${copy.title}. ${copy.description}` : generationFailureDetails(error);
};
