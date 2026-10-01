import { describe, expect, it } from "vitest";
import { hostOf, toAddress } from "./address.ts";

describe("toAddress", () => {
  it("opens web addresses and bare hosts", () => {
    expect(toAddress(" https://example.com/a?b=1 ", "google")).toBe("https://example.com/a?b=1");
    expect(toAddress("example.com", "google")).toBe("https://example.com/");
    expect(toAddress("docs.example.co.uk/guide#intro", "google")).toBe(
      "https://docs.example.co.uk/guide#intro",
    );
    expect(toAddress("localhost:3000", "google")).toBe("https://localhost:3000/");
    expect(toAddress("10.0.0.2/admin", "google")).toBe("https://10.0.0.2/admin");
  });

  it("searches everything else with the chosen engine", () => {
    expect(toAddress("weather berlin", "google")).toBe(
      "https://www.google.com/search?q=weather%20berlin",
    );
    expect(toAddress("what is a.b", "duckduckgo")).toBe(
      "https://duckduckgo.com/?q=what%20is%20a.b",
    );
    expect(toAddress("hello", "bing")).toBe("https://www.bing.com/search?q=hello");
  });

  it("never opens another scheme", () => {
    for (const input of ["javascript:alert(1)", "file:///etc/passwd", "chrome://settings"])
      expect(toAddress(input, "google")).toMatch(/^https:\/\/www\.google\.com\/search\?q=/);
  });
});

describe("hostOf", () => {
  it("names web hosts only", () => {
    expect(hostOf("https://a.example.com/x")).toBe("a.example.com");
    expect(hostOf("about:blank")).toBeNull();
    expect(hostOf("not a url")).toBeNull();
  });
});
