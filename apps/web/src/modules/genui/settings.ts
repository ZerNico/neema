// What an admin allows for ```ui blocks and for maps, each in its own row of
// the tools registry (`interactive_ui`, `maps`). Maps serve more than blocks:
// the route tool works in any chat. Read once per attempt, like the Office
// files switch, so a change applies to the next answer. A missing row means
// the defaults: on.

export const INTERACTIVE_UI_TOOL = "interactive_ui";
export const MAPS_TOOL = "maps";

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
}

export interface MapSettings {
  /** Places and routes are looked up, for blocks and the route tool, and tiles are served. */
  readonly enabled: boolean;
  readonly services: MapServices;
}

type ToolRow = { readonly enabled: boolean; readonly config: Readonly<Record<string, unknown>> };

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
 * Off switches blocks off for new answers, images included. Blocks already in
 * earlier answers keep rendering: they are stored text, and hiding them would
 * change history.
 */
export function readInteractiveUi(tool: ToolRow): InteractiveUiSettings {
  return { enabled: tool.enabled, images: tool.enabled && tool.config.images !== false };
}

/** Off means no route tool, no lookups for blocks (they say maps are off) and no tiles. */
export function readMaps(tool: ToolRow): MapSettings {
  const config = tool.config;
  return {
    enabled: tool.enabled,
    services: {
      styleLight: httpsUrl(config.styleLight, MAP_SERVICE_DEFAULTS.styleLight),
      styleDark: httpsUrl(config.styleDark, MAP_SERVICE_DEFAULTS.styleDark),
      geocoder: httpsUrl(config.geocoder, MAP_SERVICE_DEFAULTS.geocoder),
      routing: httpsUrl(config.routing, MAP_SERVICE_DEFAULTS.routing),
    },
  };
}
