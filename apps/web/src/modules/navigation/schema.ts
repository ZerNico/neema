import { Schema } from "effect";

/** Pages that can sit on the sidebar rail, in the one order both the rail and "…" use. */
export const DESTINATION_IDS = [
  "projects",
  "agents",
  "knowledge",
  "schedules",
  "skills",
  "chats",
] as const;
export const DestinationId = Schema.Literals(DESTINATION_IDS);
export type DestinationId = typeof DestinationId.Type;

/** What the rail shows for someone who never pinned or unpinned anything. */
export const DEFAULT_PINS: ReadonlyArray<DestinationId> = [
  "projects",
  "agents",
  "knowledge",
  "schedules",
];

export const SidebarPins = Schema.Struct({ pinned: Schema.Array(DestinationId) });
export type SidebarPins = typeof SidebarPins.Type;

/**
 * The whole set, so a write is idempotent and two tabs cannot interleave a pin
 * and an unpin into a set neither of them asked for.
 */
export const UpdateSidebarPinsInput = Schema.Struct({
  pinned: Schema.Array(DestinationId).check(Schema.isMaxLength(DESTINATION_IDS.length)),
});

/**
 * The known ids among `ids`, once each, in rail order: a pin lands where the
 * page always sits, never at the end. A page a later version removed is dropped
 * rather than failing the read.
 */
export const normalizePins = (ids: ReadonlyArray<string>): Array<DestinationId> => {
  const wanted = new Set(ids);
  return DESTINATION_IDS.filter((id) => wanted.has(id));
};
