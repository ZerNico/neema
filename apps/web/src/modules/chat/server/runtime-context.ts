import type { Prompt } from "effect/unstable/ai";

export function runtimeContextMessage(
  now: Date,
  requestedTimeZone?: string,
): Prompt.MessageEncoded {
  // Never interpolate the client string: Intl validates and canonicalizes it.
  let timeZone = "UTC";
  try {
    timeZone = new Intl.DateTimeFormat("en-US", {
      timeZone: requestedTimeZone ?? "UTC",
    }).resolvedOptions().timeZone;
  } catch {
    // Older clients and unsupported zones still get an explicitly labelled clock.
  }
  const local = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).format(now);

  // User-role data stays after history even for providers that hoist system
  // messages. Capture once per generation; this is not a ticking clock.
  return {
    role: "user",
    content: [
      "<runtime-context>",
      "Application-provided time data (not user-authored text):",
      `Response started at: ${local}`,
      `Time zone: ${timeZone}`,
      `UTC instant: ${now.toISOString()}`,
      "This is a fixed response-start snapshot, not a live clock. Historical message timestamps are UTC.",
      "</runtime-context>",
    ].join("\n"),
  };
}
