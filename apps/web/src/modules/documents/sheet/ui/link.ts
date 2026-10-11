import { safeLink } from "@chat/sheet-react/display";

/** An address as typed, as the link it stands for: a scheme added where one is left out. */
export function linkOf(typed: string): string | null {
  const text = typed.trim();
  if (!text) return null;
  if (/^[^@/:\s]+@[^@/:\s]+\.[a-z]{2,}$/i.test(text)) return safeLink(`mailto:${text}`);
  return safeLink(/^[a-z][a-z\d+.-]*:/i.test(text) ? text : `https://${text}`);
}
