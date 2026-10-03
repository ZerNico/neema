// Landing-page greeting. Better Auth's `name` is free-form text (a full name,
// a single handle, sometimes an email), so the greeting only uses it when the
// leading word actually reads like something to call a person.

/** Leading word of a display name, or null when it wouldn't read as a name. */
export function firstNameOf(name: string | null | undefined): string | null {
  const first = name?.trim().split(/\s+/)[0];
  // An address or a long identifier greets the account, not the person.
  if (!first || first.includes("@") || first.length > 24) return null;
  return first;
}

// `who` is ", Ada" or empty, so every line reads with and without a name.
type Line = (who: string) => string;

const ask: Line = (who) => `What can I help with${who}?`;

const NIGHT: Line[] = [
  (who) => `Up late${who}?`,
  (who) => `Night owl mode${who}?`,
  (who) => `Still up${who}?`,
];
const MORNING: Line[] = [(who) => `Good morning${who}`, (who) => `What’s first today${who}?`];
const AFTERNOON: Line[] = [
  (who) => `Good afternoon${who}`,
  (who) => `What are we working on${who}?`,
];
const EVENING: Line[] = [(who) => `Good evening${who}`, (who) => `What’s on your mind${who}?`];

function byHour(hour: number): Line[] {
  if (hour < 5 || hour >= 22) return NIGHT;
  if (hour < 12) return MORNING;
  if (hour < 17) return AFTERNOON;
  return EVENING;
}

function occasions(now: Date): Line[] {
  const day = now.getDay();
  const hour = now.getHours();
  if (now.getMonth() === 0 && now.getDate() === 1) return [(who) => `Happy New Year${who}`];
  if (day === 1 && hour >= 5 && hour < 12) return [(who) => `New week${who}. Where do we start?`];
  if (day === 5 && hour >= 12) return [(who) => `Happy Friday${who}`];
  if ((day === 0 || day === 6) && hour >= 5) return [(who) => `Weekend project${who}?`];
  return [];
}

/**
 * Picks one line for the local time. `roll` in [0, 1) chooses among the lines
 * that fit, so the caller decides how often it changes.
 */
export function greetingFor(name: string | null | undefined, now: Date, roll: number): string {
  const first = firstNameOf(name);
  const who = first === null ? "" : `, ${first}`;
  const lines = [ask, ...byHour(now.getHours()), ...occasions(now)];
  const line = lines[Math.min(lines.length - 1, Math.floor(roll * lines.length))] ?? ask;
  return line(who);
}
