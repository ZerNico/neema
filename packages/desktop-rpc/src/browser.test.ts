import { afterEach, expect, it, vi } from "vitest";
import { readDesktopBrowser, type DesktopBrowser, type DesktopBrowserAgent } from "./browser.ts";

const human = {
  partition: "persist:browser-profile",
  temporaryPartition: (id: string) => `browser-temp-profile-${id}`,
  setLifecycle: async () => {},
  onOpenTab: () => () => {},
  onFavicon: () => () => {},
  openExternal: vi.fn(async () => {}),
} satisfies DesktopBrowser;
const agent = {
  begin: async () => {},
  end: async () => {},
  cancel: async () => {},
  navigate: async () => {},
  snapshot: async () => ({
    url: "https://a.test/",
    title: "A",
    text: "",
    truncated: false,
    screenshot: null,
  }),
  waitFor: async () => ({ met: false, url: "https://a.test/" }),
  drive: async () => ({ blocked: null, saved: [] }),
  act: async () => ({ ok: true as const }),
  save: async () => [],
  siteAllowed: async () => false,
  allowSite: async () => {},
  allowedSites: async () => [],
  revokeSite: async () => {},
} satisfies DesktopBrowserAgent;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it.each(["begin", "end", "cancel", "navigate"])(
  "keeps human browsing but withholds models without %s",
  async (missing) => {
    const oldAgent = { ...agent };
    Reflect.deleteProperty(oldAgent, missing);
    vi.stubGlobal("__chatDesktop", { browser: { ...human, agent: oldAgent } });
    const admitted = readDesktopBrowser();
    expect(admitted?.agent).toBeUndefined();
    expect(admitted?.partition).toBe(human.partition);
    await admitted?.openExternal("https://a.test/");
    expect(human.openExternal).toHaveBeenCalledExactlyOnceWith("https://a.test/");
  },
);

it("admits the bounded call protocol without replacing the human bridge", () => {
  const browser = { ...human, agent };
  vi.stubGlobal("__chatDesktop", { browser });
  expect(readDesktopBrowser()).toBe(browser);
});
