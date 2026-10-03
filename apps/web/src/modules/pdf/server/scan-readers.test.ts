import { describe, expect, it } from "vitest";
import { MISTRAL_DEFAULT_BASE_URL, mistralBaseUrl } from "./scan-readers.ts";

describe("mistralBaseUrl", () => {
  it("is Mistral's own endpoint when left blank", () => {
    expect(mistralBaseUrl(undefined)).toBe(MISTRAL_DEFAULT_BASE_URL);
    expect(mistralBaseUrl("  ")).toBe(MISTRAL_DEFAULT_BASE_URL);
  });

  it("keeps another service's URL without a trailing slash", () => {
    expect(mistralBaseUrl(" https://ocr.example.eu/v1/ ")).toBe("https://ocr.example.eu/v1");
  });

  it("refuses anything that is not an http(s) URL", () => {
    expect(mistralBaseUrl("ftp://ocr.example")).toBeNull();
    expect(mistralBaseUrl("not a url")).toBeNull();
  });
});
