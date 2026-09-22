/**
 * The unsent chat request that starts schedule authoring. An edit names the
 * schedule by link, the way agent editing does, so the model opens the draft
 * against that schedule's ID.
 */
export const scheduleAuthoringRequest = (scheduleId: string | null = null) =>
  scheduleId
    ? `Help me change [this schedule](/schedules/${encodeURIComponent(scheduleId)}). Ask what I’d like to change, then prepare a draft for me to review before saving.`
    : "Help me set up a scheduled task. Ask what it should do and how often, then prepare a draft for me to review before it goes live.";
