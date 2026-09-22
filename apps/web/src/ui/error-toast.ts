import { toast } from "sonner";
import { readServerError } from "~/server-error.ts";

const asSentence = (text: string) => {
  const trimmed = text.trim();
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?…]$/.test(capital) ? capital : `${capital}.`;
};

/** What "Copy details" puts on the clipboard: enough for an admin to find the log line. */
export const errorReport = (input: {
  title: string;
  reference: string;
  raw: string;
  at: Date;
  page: string;
}) =>
  [
    input.title,
    `Reference: ${input.reference}`,
    `Time: ${input.at.toISOString()}`,
    `Page: ${input.page}`,
    "",
    input.raw,
  ].join("\n");

/**
 * The one way to report a failed request. The title is always the caller's
 * plain "Could not …" line; a reason the server gave becomes the description,
 * and an unexpected failure offers its reference for a report instead.
 */
export function toastError(title: string, error: unknown) {
  const { reason, reference, raw } = readServerError(error);
  if (reference) {
    toast.error(title, {
      description: `Something went wrong on our side. Reference ${reference}.`,
      // Long enough to reach for the button before it goes.
      duration: 15_000,
      action: {
        label: "Copy details",
        onClick: () =>
          void navigator.clipboard.writeText(
            errorReport({ title, reference, raw, at: new Date(), page: location.href }),
          ),
      },
    });
    return;
  }
  const description = reason ? asSentence(reason) : null;
  toast.error(title, description && description !== title ? { description } : undefined);
}
