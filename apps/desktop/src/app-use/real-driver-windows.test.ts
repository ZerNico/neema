import { type ChildProcess, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { type AppDriver, AppDriverError, startAppDriver } from "./driver.ts";
import { buildOutline } from "./outline.ts";
import type { Look } from "./protocol.ts";

/**
 * The Windows driver against real apps, opt-in because it opens Calculator and takes the front:
 * set NEEMA_APP_DRIVER to a built driver (`cargo build --manifest-path
 * native/app-driver/windows/Cargo.toml`, then `native/app-driver/windows/target/debug/app-driver.exe`).
 * Calculator's names are read in English, so this needs an English Windows display language.
 */
const EXECUTABLE = process.env.NEEMA_APP_DRIVER;
const CALCULATOR = "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App";

describe.skipIf(!EXECUTABLE || process.platform !== "win32")("the Windows app driver", () => {
  let driver: AppDriver;

  const lookAt = async (): Promise<Look> => {
    // Opening is asynchronous; the window appears a moment after `open` returns. Bounded, so a
    // Calculator that never shows fails the test instead of spinning past its timeout.
    for (let attempt = 0; ; attempt++) {
      try {
        return await driver.call("look", { appId: CALCULATOR });
      } catch (error) {
        const waiting = error instanceof AppDriverError && /no_window|not_running/.test(error.code);
        if (!waiting || attempt >= 200) throw error;
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
  };

  const display = (look: Look) =>
    look.nodes
      .map((node) => /^Display is (.*)$/.exec(node.name ?? "")?.[1]?.replace(/\p{Cf}/gu, ""))
      .find((value) => value !== undefined);

  /** Looks until the display reads `value`: an app redraws after the input that changed it. */
  const displays = async (value: string) => {
    let shown = display(await lookAt());
    while (shown !== value) shown = display(await lookAt());
    return shown;
  };

  const button = (look: Look, name: string) => {
    const node = look.nodes.find((entry) => entry.role === "button" && entry.name === name);
    expect(node?.frame, name).toBeDefined();
    return node!;
  };

  beforeAll(async () => {
    driver = startAppDriver(EXECUTABLE!);
    await driver.call("open", { appId: "Calculator" });
  }, 30_000);
  afterAll(() => driver.close());

  beforeEach(async () => {
    await lookAt();
    await driver.call("key", { keys: "Escape" });
  });

  test("needs no grants", async () => {
    expect(await driver.call("permissions", {})).toEqual({
      accessibility: true,
      capture: true,
      background: false,
    });
  });

  test("names a packaged app by its AppUserModelID, running or not", async () => {
    expect(await driver.call("resolve", { app: "calculator" })).toMatchObject({
      appId: CALCULATOR,
      name: "Calculator",
      running: true,
    });
    const listed = (await driver.call("apps", {})).apps.find((app) => app.appId === CALCULATOR);
    expect(listed).toMatchObject({ name: "Calculator", offLimits: false });
  });

  test("presses by reference", async () => {
    const outline = buildOutline(await lookAt());
    const press = async (label: string) => {
      const line = outline.text.split("\n").find((entry) => entry.includes(`button "${label}"`));
      await driver.call("click", { node: outline.refs.get(line!.trim().split(" ")[0]!)! });
    };
    for (const label of ["Seven", "Multiply by", "Six", "Equals"]) await press(label);
    expect(await displays("42")).toBe("42");
  });

  test("clicks by coordinate", async () => {
    const look = await lookAt();
    for (const name of ["Seven", "Multiply by", "Eight", "Equals"]) {
      const { frame } = button(look, name);
      await driver.call("click", {
        at: { x: frame!.x + frame!.width / 2, y: frame!.y + frame!.height / 2 },
      });
    }
    expect(await displays("56")).toBe("56");
  });

  test("types and presses keys", async () => {
    await driver.call("type", { text: "12+30" });
    await driver.call("key", { keys: "Return" });
    expect(await displays("42")).toBe("42");
  });

  test("captures only the window, and a part of it in detail", async () => {
    const look = await lookAt();
    expect(Buffer.from(look.image.data, "base64").subarray(1, 4).toString()).toBe("PNG");
    expect(Math.max(look.image.width, look.image.height)).toBeLessThanOrEqual(1280);
    expect(look.image.width / look.image.height).toBeCloseTo(
      look.window.width / look.window.height,
      1,
    );
    const zoom = await driver.call("zoom", { region: { x: 0, y: 0, width: 100, height: 50 } });
    expect(zoom.width / zoom.height).toBeCloseTo(2, 1);
    const peek = await driver.call("peek", {});
    expect(Math.max(peek.width, peek.height)).toBeLessThanOrEqual(640);
  });

  test("refuses off-limits apps, stale nodes and unknown keys", async () => {
    for (const app of ["C:\\Windows\\System32\\cmd.exe", "Registry Editor"])
      await expect(driver.call("resolve", { app })).rejects.toMatchObject({ code: "off_limits" });
    await expect(
      driver.call("open", { appId: "C:\\Windows\\System32\\cmd.exe" }),
    ).rejects.toMatchObject({ code: "off_limits" });
    await expect(driver.call("click", { node: "n999999" })).rejects.toMatchObject({
      code: "stale_node",
    });
    await expect(driver.call("key", { keys: "hyper+q" })).rejects.toMatchObject({
      code: "invalid_params",
    });
  });
});

type PageEvent = { type: string; target?: string; value?: string; detail?: number; key?: string };

/**
 * Chromium, through an Electron page that reports what it receives: it ignores posted window
 * messages, which is why the driver sends real input.
 */
describe.skipIf(!EXECUTABLE || process.platform !== "win32")(
  "the Windows app driver on Chromium",
  () => {
    let driver: AppDriver;
    let page: ChildProcess;
    let pid: number;
    let look: Look;
    let outline: ReturnType<typeof buildOutline>;
    const events: PageEvent[] = [];
    let arrived = () => {};
    // Outside Electron, the package resolves to the path of its binary, which names the app.
    const electron = String(createRequire(import.meta.url)("electron"));

    beforeAll(async () => {
      // A shell started from an Electron app inherits this, which runs Electron as plain Node.
      const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env;
      page = spawn(
        electron,
        [fileURLToPath(new URL("fixtures/chromium-target.cjs", import.meta.url))],
        { stdio: ["pipe", "pipe", "ignore"], env },
      );
      pid = await new Promise<number>((resolve) => {
        createInterface({ input: page.stdout! }).on("line", (line) => {
          if (line.startsWith("READY ")) resolve(Number(line.slice(6)));
          if (line.startsWith("EVENT ")) {
            events.push(JSON.parse(line.slice(6)));
            arrived();
          }
        });
      });
      driver = startAppDriver(EXECUTABLE!);
      look = await driver.call("look", { appId: electron, pid });
      outline = buildOutline(look);
    }, 30_000);
    afterAll(() => {
      driver.close();
      page.kill();
    });
    beforeEach(() => {
      events.length = 0;
    });

    /** Resolves once the page reported an event like this; the test's timeout bounds it. */
    const received = async (match: (event: PageEvent) => boolean) => {
      while (!events.some(match)) await new Promise<void>((resolve) => (arrived = resolve));
      return events.find(match)!;
    };

    const node = (label: string) => {
      const line = outline.text.split("\n").find((entry) => entry.includes(label));
      expect(line, label).toBeDefined();
      return outline.refs.get(line!.trim().split(" ")[0]!)!;
    };
    const centre = (label: string) => {
      const { frame } = look.nodes.find((entry) => entry.id === node(label))!;
      return { x: frame!.x + frame!.width / 2, y: frame!.y + frame!.height / 2 };
    };
    // Unnamed and offering no pattern, the canvas has no line in the outline; a point reaches it.
    const canvas = () => {
      const { frame } = look.nodes.find((entry) => entry.role === "image")!;
      return { x: frame!.x + frame!.width / 2, y: frame!.y + frame!.height / 2 };
    };

    test("reads the page, not only the window around it", () => {
      expect(outline.text).toMatch(/webArea/);
      expect(outline.text).toMatch(/textField "Field"/);
      expect(outline.text).toMatch(/button "Go"/);
    });

    test("clicks by coordinate, first click included", async () => {
      await driver.call("click", { at: centre('button "Go"') });
      expect(await received((event) => event.type === "click")).toMatchObject({
        target: "go",
        trusted: true,
      });
    });

    test("clicks by reference", async () => {
      await driver.call("click", { node: node('button "Go"') });
      await received((event) => event.type === "click" && event.target === "go");
    });

    test("follows a link that changes the page in place, without crashing it", async () => {
      await driver.call("click", { node: node('link "Next page"') });
      await received((event) => event.type === "navigated" || event.type === "gone");
      expect(events.find((event) => event.type === "gone")).toBeUndefined();
    });

    test("clicks a canvas, double clicks and right clicks", async () => {
      await driver.call("click", { at: canvas() });
      await received((event) => event.type === "click" && event.target === "canvas");
      await driver.call("click", { at: centre('button "Go"'), count: 2 });
      await received((event) => event.type === "click" && event.detail === 2);
      await driver.call("click", { at: centre('button "Go"'), button: "right" });
      await received((event) => event.type === "contextmenu" && event.target === "go");
    });

    test("types into a field by reference and presses keys", async () => {
      await driver.call("type", { node: node('textField "Notes"'), text: "yo" });
      await received((event) => event.type === "input" && event.value === "yo");
      await driver.call("key", { keys: "Return" });
      await received((event) => event.type === "keydown" && event.key === "Enter");
    });

    test("scrolls what is under a point", async () => {
      await driver.call("scroll", { at: centre('button "Go"'), y: -2 });
      await received((event) => event.type === "wheel");
    });

    test("drags with the button held", async () => {
      const from = canvas();
      await driver.call("drag", { from, to: { x: from.x + 40, y: from.y } });
      await received((event) => event.type === "click" && event.target === "canvas");
    });
  },
);
