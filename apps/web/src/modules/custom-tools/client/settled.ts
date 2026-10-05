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

export const errorMessage = async (error: unknown): Promise<string> => {
  if (error instanceof Response) {
    const body = await error.text();
    return validationMessages(body) ?? (body || `${error.status}`);
  }
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
};

/**
 * A refused server function can arrive as the Response it threw rather than
 * as a rejection (see skill-import-page.tsx), so the value is not a result
 * until it is one.
 */
export const settled = async <T>(call: Promise<T>): Promise<T> => {
  const result = await call;
  if (result instanceof Response) throw new Error(await errorMessage(result));
  return result;
};
