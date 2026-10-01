import { expect, it } from "vitest";
import { blockedSite } from "./gate.ts";

const driving = { conversationId: "c1", allow: new Set(["example.com"]) };
const allowedInChat = (conversationId: string, url: string) =>
  conversationId === "c1" && url.startsWith("https://docs.github.com");

it("stops a driven page only at sites neither the call nor the chat allows", () => {
  expect(blockedSite(driving, "https://www.example.com/next", allowedInChat)).toBeNull();
  expect(blockedSite(driving, "https://docs.github.com/a", allowedInChat)).toBeNull();
  expect(blockedSite(driving, "https://evil.test/?q=secret", allowedInChat)).toBe("evil.test");
});

it("never gates the person's own browsing or non-web addresses", () => {
  expect(blockedSite(undefined, "https://evil.test/", allowedInChat)).toBeNull();
  expect(blockedSite(driving, "about:blank", allowedInChat)).toBeNull();
});
