import { m } from "~/paraglide/messages.js";

/**
 * The unsent chat request that starts schedule authoring. An edit names the
 * schedule by link, the way agent editing does, so the model opens the draft
 * against that schedule's ID. It is the person's own message, so it is in
 * their language.
 */
export const scheduleAuthoringRequest = (scheduleId: string | null = null) =>
  scheduleId
    ? m.schedules_authoring_request_edit({ link: `/schedules/${encodeURIComponent(scheduleId)}` })
    : m.schedules_authoring_request_create();
