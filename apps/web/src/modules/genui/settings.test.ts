import { describe, expect, it } from "vitest";
import { MAP_SERVICE_DEFAULTS, readInteractiveUi } from "./settings.ts";

describe("readInteractiveUi", () => {
  it("defaults to on when the row is missing", () => {
    expect(readInteractiveUi(null)).toEqual({
      enabled: true,
      images: true,
      maps: true,
      mapServices: MAP_SERVICE_DEFAULTS,
    });
  });

  it("keeps images on unless switched off", () => {
    expect(readInteractiveUi({ enabled: true, config: {} })).toMatchObject({ images: true });
    expect(readInteractiveUi({ enabled: true, config: { images: false } })).toMatchObject({
      enabled: true,
      images: false,
    });
  });

  it("turns images off with the whole feature", () => {
    expect(
      readInteractiveUi({ enabled: false, config: { images: true, maps: true } }),
    ).toMatchObject({ enabled: false, images: false, maps: false });
  });

  it("takes an admin's https map services and falls back for anything else", () => {
    const settings = readInteractiveUi({
      enabled: true,
      config: {
        mapStyleLight: " https://tiles.example.org/styles/light/ ",
        mapGeocoder: "http://insecure.example.org",
        mapRouting: "not a url",
      },
    });
    expect(settings.mapServices).toEqual({
      styleLight: "https://tiles.example.org/styles/light",
      styleDark: MAP_SERVICE_DEFAULTS.styleDark,
      geocoder: MAP_SERVICE_DEFAULTS.geocoder,
      routing: MAP_SERVICE_DEFAULTS.routing,
    });
  });
});
