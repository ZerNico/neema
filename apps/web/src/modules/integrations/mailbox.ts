// No `*`: legal, but in an allowance it would read as a wildcard it is not.
const LOCAL_PART = /^[a-z0-9!#$%&'+/=?^_`{|}~.-]{1,64}$/;
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * One bare email address in the form an allowance compares: lowercased, its
 * domain in ASCII (IDNA), or null. Display names, angle brackets, lists and
 * quoted local parts are refused rather than unpicked, so what a schedule's
 * owner typed and what a call names can only match exactly. Grants and tool
 * payloads both go through here.
 */
export const parseMailbox = (raw: string): string | null => {
  const value = raw.trim().toLowerCase();
  if (value.length > 254) return null;
  const at = value.lastIndexOf("@");
  if (at <= 0 || at !== value.indexOf("@")) return null;
  const local = value.slice(0, at);
  if (!LOCAL_PART.test(local) || local.startsWith(".") || local.endsWith(".")) return null;
  if (local.includes("..")) return null;
  const written = value.slice(at + 1);
  // URL parsing would quietly drop a port or a path instead of failing.
  if (!/^[^\s:/?#[\]\\%]+$/.test(written)) return null;
  let domain: string;
  try {
    domain = new URL(`http://${written}`).hostname;
  } catch {
    return null;
  }
  const labels = domain.split(".");
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return null;
  // An address literal or a bare number would pass the label check.
  if (/^[0-9]+$/.test(labels.at(-1)!)) return null;
  return `${local}@${domain}`;
};
