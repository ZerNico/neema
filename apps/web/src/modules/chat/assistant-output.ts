import { Schema } from "effect";
import { Attachment } from "~/modules/attachments/schema.ts";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "~/modules/attachments/constants.ts";

/**
 * Bounds for what an answer produces itself. Generated images (the model's own
 * and the image tool's) have their own count; other tool files keep theirs;
 * one byte ceiling covers both.
 */
export const ASSISTANT_FILE_LIMITS = {
  count: MAX_ATTACHMENTS_PER_MESSAGE,
  bytes: MAX_ATTACHMENT_BYTES,
  totalBytes: MAX_ATTACHMENT_BYTES * 2,
  images: 16,
  answerBytes: 64 * 1024 * 1024,
  replayBytes: 1024 * 1024,
} as const;
const Offset = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
/**
 * One file an assistant answer produced, anchored to the text it appeared in.
 * `origin` names the tool call that returned it; absent for a model's own
 * image output.
 */
export const AssistantFile = Schema.Struct({
  v: Schema.Literal(1),
  attachment: Attachment,
  textOffset: Offset,
  turnIndex: Offset,
  eventIndex: Offset,
  callIndex: Offset,
  origin: Schema.optional(Schema.Struct({ toolCallId: Schema.String })),
  source: Schema.Literals(["native", "image-tool", "tool"]),
});
export type AssistantFile = typeof AssistantFile.Type;
export type AssistantFileSource = AssistantFile["source"];

/** Generated images count against their own bound, everything else against the files'. */
export const isGeneratedImage = (source: AssistantFileSource) => source !== "tool";
/** One image found for a ```ui block's query, stored as a `search_image` attachment. */
export const UiImage = Schema.Struct({
  attachmentId: Schema.String,
  pageUrl: Schema.String,
  title: Schema.String,
  /** Stored bytes, for the preview; absent on images stored before it was kept. */
  size: Schema.optional(Schema.Number),
  width: Schema.optional(Schema.Number),
  height: Schema.optional(Schema.Number),
});
export type UiImage = typeof UiImage.Type;
/**
 * What one query came to. `search_off` means the attempt had no web search to
 * ask, so the reader is told why rather than shown a broken tile.
 */
export const UiImageResult = Schema.Struct({
  status: Schema.Literals(["resolved", "unavailable", "search_off"]),
  items: Schema.Array(UiImage),
});
export type UiImageResult = typeof UiImageResult.Type;
/** Image results by normalised query (`normalizeQuery`). */
export type UiImages = Readonly<Record<string, UiImageResult>>;

/**
 * Where a ```ui map's place name was found. `unavailable`: no match, or the
 * lookup failed. `maps_off`: maps were off for the attempt, so nothing was asked.
 */
export interface UiPlace {
  readonly status: "resolved" | "unavailable" | "maps_off";
  readonly lat?: number;
  readonly lng?: number;
  /** The geocoder's name for it, shown when the block gave none. */
  readonly name?: string;
}
/** Place results by normalised place name. */
export type UiPlaces = Readonly<Record<string, UiPlace>>;

/** A road, cycle or walking route between a map's stops, simplified for drawing. */
export interface UiRoute {
  readonly status: "resolved" | "unavailable" | "maps_off";
  /** [lng, lat] pairs, as GeoJSON orders them. */
  readonly path?: ReadonlyArray<readonly [number, number]>;
  /** Metres. */
  readonly distance?: number;
  /** Each stretch between consecutive stops, in metres and seconds. */
  readonly legs?: ReadonlyArray<{ readonly distance: number; readonly duration: number }>;
  /** Seconds. */
  readonly duration?: number;
}
/** Route results by `routeKey`. */
export type UiRoutes = Readonly<Record<string, UiRoute>>;

/** Everything the server looked up for an answer's blocks, as one snapshot. */
export interface UiLookups {
  readonly images: UiImages;
  readonly places: UiPlaces;
  readonly routes: UiRoutes;
}

export interface AssistantOutput {
  v: 1;
  files: ReadonlyArray<AssistantFile>;
  images?: UiImages;
  places?: UiPlaces;
  routes?: UiRoutes;
}

/**
 * One result by a model-written key. Own keys only: a place or query named
 * `constructor` would otherwise read a prototype member as a result.
 */
export const lookupOf = <T>(results: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(results, key) ? results[key] : undefined;

export const NO_LOOKUPS: UiLookups = { images: {}, places: {}, routes: {} };

/** Later results win per key; neither side is changed. */
export const mergeLookups = (a: UiLookups, b: Partial<UiLookups>): UiLookups => ({
  images: { ...a.images, ...b.images },
  places: { ...a.places, ...b.places },
  routes: { ...a.routes, ...b.routes },
});

/** The lookups an output holds, with an empty record for each kind it has none of. */
export const lookupsOf = (output: AssistantOutput | null | undefined): UiLookups => ({
  images: output?.images ?? {},
  places: output?.places ?? {},
  routes: output?.routes ?? {},
});
