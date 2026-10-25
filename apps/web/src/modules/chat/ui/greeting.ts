import { m } from "~/paraglide/messages.js";
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

const ask: Line = (who) => m.chat_greeting_help({ who });

const NIGHT: Line[] = [
  (who) => m.chat_greeting_up_late({ who }),
  (who) => m.chat_greeting_night_owl({ who }),
  (who) => m.chat_greeting_still_up({ who }),
];
const MORNING: Line[] = [
  (who) => m.chat_greeting_morning({ who }),
  (who) => m.chat_greeting_first_today({ who }),
];
const AFTERNOON: Line[] = [
  (who) => m.chat_greeting_afternoon({ who }),
  (who) => m.chat_greeting_working_on({ who }),
];
const EVENING: Line[] = [
  (who) => m.chat_greeting_evening({ who }),
  (who) => m.chat_greeting_on_your_mind({ who }),
];

function byHour(hour: number): Line[] {
  if (hour < 5 || hour >= 22) return NIGHT;
  if (hour < 12) return MORNING;
  if (hour < 17) return AFTERNOON;
  return EVENING;
}

function occasions(now: Date): Line[] {
  const day = now.getDay();
  const hour = now.getHours();
  if (now.getMonth() === 0 && now.getDate() === 1)
    return [(who) => m.chat_greeting_new_year({ who })];
  if (day === 1 && hour >= 5 && hour < 12) return [(who) => m.chat_greeting_new_week({ who })];
  if (day === 5 && hour >= 12) return [(who) => m.chat_greeting_friday({ who })];
  if ((day === 0 || day === 6) && hour >= 5) return [(who) => m.chat_greeting_weekend({ who })];
  return [];
}

/**
 * Picks one line for the local time. `roll` in [0, 1) chooses among the lines
 * that fit, so the caller decides how often it changes.
 */
export function greetingFor(name: string | null | undefined, now: Date, roll: number): string {
  const first = firstNameOf(name);
  const who = first === null ? "" : m.chat_greeting_who({ name: first });
  const lines = [ask, ...byHour(now.getHours()), ...occasions(now)];
  const line = lines[Math.min(lines.length - 1, Math.floor(roll * lines.length))] ?? ask;
  return line(who);
}
