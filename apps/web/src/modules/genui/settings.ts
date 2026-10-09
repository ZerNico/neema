// What an admin allows for ```ui blocks, kept in the `interactive_ui` row of
// the tools registry. Read once per attempt, like the Office files switch, so
// a change applies to the next answer. A missing row means the defaults: on.

export const INTERACTIVE_UI_TOOL = "interactive_ui";

/**
 * The public OpenStreetMap services maps use unless an admin points them
 * elsewhere. All are free and keyless, and all ask for light use: maps look
 * each place and route up once per answer and serve tiles through a cache.
 */
export const MAP_SERVICE_DEFAULTS = {
  styleLight: "https://tiles.openfreemap.org/styles/positron",
  styleDark: "https://tiles.openfreemap.org/styles/dark",
  geocoder: "https://photon.komoot.io",
  routing: "https://routing.openstreetmap.de",
} as const;

export interface MapServices {
  readonly styleLight: string;
  readonly styleDark: string;
  /** A Photon search API: `/api?q=` answering with GeoJSON points. */
  readonly geocoder: string;
  /** An OSRM server with routed-car, routed-bike and routed-foot profiles, like FOSSGIS's. */
  readonly routing: string;
}

export interface InteractiveUiSettings {
  /** The model is offered the skill that teaches blocks. */
  readonly enabled: boolean;
  /** Image tags are looked up; still only with the attempt's web search. */
  readonly images: boolean;
  /** Maps draw, and their places and routes are looked up. */
  readonly maps: boolean;
  readonly mapServices: MapServices;
}

const httpsUrl = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") return fallback;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" ? url.href.replace(/\/+$/, "") : fallback;
  } catch {
    return fallback;
  }
};

/**
 * Off switches the whole feature off for new answers, images and maps
 * included. Blocks already in earlier answers keep rendering: they are
 * stored text, and hiding them would change history.
 */
export function readInteractiveUi(
  tool: { readonly enabled: boolean; readonly config: Readonly<Record<string, unknown>> } | null,
): InteractiveUiSettings {
  const enabled = tool?.enabled ?? true;
  const config = tool?.config ?? {};
  return {
    enabled,
    images: enabled && config.images !== false,
    maps: enabled && config.maps !== false,
    mapServices: {
      styleLight: httpsUrl(config.mapStyleLight, MAP_SERVICE_DEFAULTS.styleLight),
      styleDark: httpsUrl(config.mapStyleDark, MAP_SERVICE_DEFAULTS.styleDark),
      geocoder: httpsUrl(config.mapGeocoder, MAP_SERVICE_DEFAULTS.geocoder),
      routing: httpsUrl(config.mapRouting, MAP_SERVICE_DEFAULTS.routing),
    },
  };
}
