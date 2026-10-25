import { m } from "~/paraglide/messages.js";
import { baseLocale } from "~/paraglide/runtime.js";

/** Application-owned terminal failure copy; never render raw provider diagnostics here. */
export const RESPONSE_FAILURES = {
  ResponseFiltered: {
    title: m.chat_failure_filtered_title,
    description: m.chat_failure_filtered_description,
  },
  ResponseError: {
    title: m.chat_failure_error_title,
    description: m.chat_failure_try_again_description,
  },
  ResponseIncomplete: {
    title: m.chat_failure_incomplete_title,
    description: m.chat_failure_try_again_description,
  },
  ResponseEmpty: {
    title: m.chat_failure_empty_title,
    description: m.chat_failure_try_again_description,
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

/**
 * Why an answer failed, in English for an outside client's model: the app's
 * own copy, else the provider's reason.
 */
export const generationFailureReason = (error: string | null | undefined) => {
  if (!error) return null;
  const copy = responseFailureCopy(error);
  const english = { locale: baseLocale } as const;
  return copy
    ? `${copy.title({}, english)}. ${copy.description({}, english)}`
    : generationFailureDetails(error);
};
