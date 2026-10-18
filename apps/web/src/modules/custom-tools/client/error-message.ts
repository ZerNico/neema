/** A failed validator answers with its issue list as JSON; show the messages, not the envelope. */
const validationMessages = (body: string): string | null => {
  try {
    const issues: unknown = JSON.parse(body);
    if (!Array.isArray(issues) || issues.length === 0) return null;
    const messages = issues.flatMap((issue: unknown) =>
      issue && typeof issue === "object" && "message" in issue ? [String(issue.message)] : [],
    );
    return messages.length === issues.length ? messages.join("\n") : null;
  } catch {
    return null;
  }
};

export const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return validationMessages(error.message) ?? error.message;
  return "Something went wrong.";
};
