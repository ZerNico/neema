import { expect, it } from "vitest";
import { browserUserAgent } from "./user-agent.ts";

const electron =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.130 Electron/44.4.5 Safari/537.36";

it("drops only the app's own token, leaving Electron's default exactly", () => {
  expect(browserUserAgent(electron.replace(" Chrome/", " neema/0.0.0 Chrome/"), "neema")).toBe(
    electron,
  );
  expect(browserUserAgent(electron, "neema")).toBe(electron);
});
