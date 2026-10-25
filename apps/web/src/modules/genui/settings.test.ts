import { describe, expect, it } from "vitest";
import { MAP_SERVICE_DEFAULTS, readInteractiveUi, readMaps } from "./settings.ts";

describe("readInteractiveUi", () => {
  it("keeps images on unless switched off", () => {
    expect(readInteractiveUi({ enabled: true, config: {} })).toMatchObject({ images: true });
    expect(readInteractiveUi({ enabled: true, config: { images: false } })).toEqual({
      enabled: true,
      images: false,
    });
  });

  it("turns images off with the whole feature", () => {
    expect(readInteractiveUi({ enabled: false, config: { images: true } })).toEqual({
      enabled: false,
      images: false,
    });
  });
});

describe("readMaps", () => {
  it("uses the public services when none are set", () => {
    expect(readMaps({ enabled: true, config: {} })).toEqual({
      enabled: true,
      services: MAP_SERVICE_DEFAULTS,
    });
  });

  it("follows its own switch, whatever interactive answers do", () => {
    expect(readMaps({ enabled: false, config: {} }).enabled).toBe(false);
    expect(readMaps({ enabled: true, config: {} }).enabled).toBe(true);
  });

  it("takes an admin's https services and falls back for anything else", () => {
    const settings = readMaps({
      enabled: true,
      config: {
        styleLight: " https://tiles.example.org/styles/light/ ",
        geocoder: "http://insecure.example.org",
        routing: "not a url",
      },
    });
    expect(settings.services).toEqual({
      styleLight: "https://tiles.example.org/styles/light",
      styleDark: MAP_SERVICE_DEFAULTS.styleDark,
      geocoder: MAP_SERVICE_DEFAULTS.geocoder,
      routing: MAP_SERVICE_DEFAULTS.routing,
    });
  });
});
