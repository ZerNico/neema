import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { type AppDriver, AppDriverError, startAppDriver } from "./driver.ts";
import { buildOutline } from "./outline.ts";
import type { Look, UiNode } from "./protocol.ts";

/**
 * The platform's real driver against a real app, opt-in because it opens Calculator and needs
 * the Accessibility and Screen Recording grants: set NEEMA_APP_DRIVER to a built driver
 * (`swift build --package-path native/app-driver/macos`, then `.build/debug/app-driver`).
 * No action may bring Calculator forward: app use works behind the person's back. The front
 * app itself may change, since the person may be using the machine meanwhile.
 */
const EXECUTABLE = process.env.NEEMA_APP_DRIVER;
const CALCULATOR = "com.apple.calculator";

describe.skipIf(!EXECUTABLE || process.platform !== "darwin")("the macOS app driver", () => {
  let driver: AppDriver;

  const frontApp = async () => (await driver.call("apps", {})).apps.find((app) => app.front)?.appId;

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
      .filter((node) => node.role === "text")
      .map((node) => node.value?.replace(/\p{Cf}/gu, ""))
      .at(-1);

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
    await driver.call("open", { appId: CALCULATOR });
  });
  afterAll(() => driver.close());

  beforeEach(async () => {
    await lookAt();
    await driver.call("key", { keys: "Escape" });
    await driver.call("key", { keys: "Escape" });
  });

  test("runs on the spawning app's grants", async () => {
    expect(await driver.call("permissions", {})).toEqual({
      accessibility: true,
      capture: true,
      background: true,
    });
  });

  test("presses by reference", async () => {
    const outline = buildOutline(await lookAt());
    const press = async (label: string) => {
      const line = outline.text.split("\n").find((entry) => entry.includes(`button "${label}"`));
      await driver.call("click", { node: outline.refs.get(line!.trim().split(" ")[0]!)! });
    };
    for (const label of ["7", "Multiply", "6", "Equals"]) await press(label);
    expect(await displays("42")).toBe("42");
    expect(await frontApp()).not.toBe(CALCULATOR);
  });

  test("clicks by coordinate in the background", async () => {
    const look = await lookAt();
    for (const name of ["7", "Multiply", "8", "Equals"]) {
      const { frame } = button(look, name);
      await driver.call("click", {
        at: { x: frame!.x + frame!.width / 2, y: frame!.y + frame!.height / 2 },
      });
    }
    expect(await displays("56")).toBe("56");
    expect(await frontApp()).not.toBe(CALCULATOR);
  });

  test("types and presses keys in the background", async () => {
    await driver.call("type", { text: "12+30" });
    await driver.call("key", { keys: "Return" });
    expect(await displays("42")).toBe("42");
    expect(await frontApp()).not.toBe(CALCULATOR);
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
    expect(zoom.width).toBeGreaterThanOrEqual(100);
  });

  test("refuses off-limits apps, stale nodes and unknown keys", async () => {
    await expect(driver.call("look", { appId: "com.apple.Terminal" })).rejects.toMatchObject({
      code: "off_limits",
    });
    await expect(driver.call("open", { appId: "com.apple.Terminal" })).rejects.toMatchObject({
      code: "off_limits",
    });
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
 * Chromium, through an Electron page that reports what it receives: Chromium gates synthetic
 * input and its accessibility tree differently from AppKit (see SkyLight.swift and Apps.swift).
 */
describe.skipIf(!EXECUTABLE || process.platform !== "darwin")(
  "the macOS app driver on Chromium",
  () => {
    let driver: AppDriver;
    let page: ChildProcess;
    let pid: number;
    let look: Look;
    let outline: ReturnType<typeof buildOutline>;
    const events: PageEvent[] = [];
    let arrived = () => {};

    beforeAll(async () => {
      // Outside Electron, the package resolves to the path of its binary.
      const electron = String(createRequire(import.meta.url)("electron"));
      // A shell started from an Electron app inherits this, which runs Electron as plain Node.
      const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env;
      page = spawn(
        electron,
        [fileURLToPath(new URL("fixtures/chromium-target.cjs", import.meta.url))],
        {
          stdio: ["pipe", "pipe", "ignore"],
          env,
        },
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
      look = await driver.call("look", { appId: "com.github.Electron", pid });
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
      await driver.call("click", { at: centre("image") });
      await received((event) => event.type === "click" && event.target === "canvas");
      await driver.call("click", { at: centre('button "Go"'), count: 2 });
      await received((event) => event.type === "click" && event.detail === 2);
      await driver.call("click", { at: centre('button "Go"'), button: "right" });
      await received((event) => event.type === "contextmenu" && event.target === "go");
    });

    test("types into a field by reference and presses keys", async () => {
      await driver.call("type", { node: node('textArea "Notes"'), text: "yo" });
      await received((event) => event.type === "input" && event.value === "yo");
      await driver.call("key", { keys: "Return" });
      await received((event) => event.type === "keydown" && event.key === "Enter");
    });

    test("scrolls what is under a point", async () => {
      await driver.call("scroll", { at: centre('button "Go"'), y: -2 });
      await received((event) => event.type === "wheel");
    });
  },
);

const centre = ({ frame }: UiNode) => ({
  x: frame!.x + frame!.width / 2,
  y: frame!.y + frame!.height / 2,
});

/** A native fixture compiled into a throwaway bundle, since a look finds an app by bundle id. */
const bundled = (fixture: string, bundleId: string) => {
  const bundle = join(mkdtempSync(join(tmpdir(), `${fixture}-`)), `${fixture}.app`);
  mkdirSync(join(bundle, "Contents/MacOS"), { recursive: true });
  writeFileSync(
    join(bundle, "Contents/Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string><key>CFBundleExecutable</key><string>${fixture}</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`,
  );
  execFileSync("swiftc", [
    "-O",
    "-o",
    join(bundle, "Contents/MacOS", fixture),
    fileURLToPath(new URL(`fixtures/${fixture}.swift`, import.meta.url)),
  ]);
  return join(bundle, "Contents/MacOS", fixture);
};

/** A running fixture that reports its state as JSON lines, every one kept. */
const launch = async (executable: string, args: string[] = []) => {
  const app = spawn(executable, args, { stdio: ["pipe", "pipe", "ignore"] });
  const states: Record<string, unknown>[] = [];
  let changed = () => {};
  const pid = await new Promise<number>((resolve) => {
    createInterface({ input: app.stdout! }).on("line", (line) => {
      if (line.startsWith("READY ")) resolve(Number(line.slice(6)));
      if (line === "PONG") pongs.shift()?.();
      if (line.startsWith("STATE ")) {
        states.push(JSON.parse(line.slice(6)));
        changed();
      }
    });
  });
  const pongs: (() => void)[] = [];
  return {
    app,
    pid,
    states,
    get state() {
      return states.at(-1) ?? {};
    },
    /** Resolves once the app has handled every event that reached it before this. */
    settled() {
      return new Promise<void>((resolve) => {
        pongs.push(resolve);
        app.stdin!.write("ping\n");
      });
    },
    /** Resolves once the app reports a state like this; the test's timeout bounds it. */
    async reaches(match: (state: Record<string, unknown>) => boolean) {
      while (!match(states.at(-1) ?? {})) await new Promise<void>((resolve) => (changed = resolve));
    },
  };
};

/**
 * Keys go to an app's key window, which need not be the window looked at: a document behind
 * its own utility panel.
 */
describe.skipIf(!EXECUTABLE || process.platform !== "darwin")(
  "the macOS app driver with two windows",
  () => {
    let driver: AppDriver;
    let fixture: Awaited<ReturnType<typeof launch>>;

    beforeAll(async () => {
      fixture = await launch(bundled("two-windows", "app.neema.test.two-windows"));
      driver = startAppDriver(EXECUTABLE!);
    }, 120_000);
    afterAll(() => {
      driver.close();
      fixture.app.kill();
    });

    test("types and presses keys into the window looked at, then hands its keys back", async () => {
      const look = await driver.call("look", {
        appId: "app.neema.test.two-windows",
        pid: fixture.pid,
      });
      expect(look.title).toBe("Document");
      await driver.call("type", { text: "hi" });
      await driver.call("key", { keys: "x" });
      await fixture.reaches((now) => now.document === "hix");
      expect(fixture.state.panel).toBe("");
      await fixture.reaches((now) => now.key === "Panel");
    });
  },
);

/**
 * A menu opened in a background app takes key focus from the person's app, and their typing
 * with it, though nothing is activated or raised. This brings a fixture forward for the person.
 */
describe.skipIf(!EXECUTABLE || process.platform !== "darwin")(
  "the macOS app driver opening a menu behind the person's app",
  () => {
    let driver: AppDriver;
    let person: Awaited<ReturnType<typeof launch>>;
    let target: Awaited<ReturnType<typeof launch>>;

    beforeAll(async () => {
      const executable = bundled("menu-focus", "app.neema.test.menu-focus");
      target = await launch(executable, ["target"]);
      person = await launch(executable, ["front"]);
      await person.reaches((now) => now.key === true && now.active === true);
      driver = startAppDriver(EXECUTABLE!);
    }, 120_000);
    afterAll(() => {
      driver.close();
      person.app.kill();
      target.app.kill();
    });

    const opens = {
      "by reference": (choice: UiNode) => ({ node: choice.id }),
      "by a click on the button": (choice: UiNode) => ({ at: centre(choice) }),
      "as a context menu": (choice: UiNode) => ({
        at: { x: centre(choice).x + 200, y: centre(choice).y },
        button: "right" as const,
      }),
    };
    test.each(Object.keys(opens))(
      "keeps the person's window key while a menu opened %s is open",
      async (way) => {
        const look = await driver.call("look", {
          appId: "app.neema.test.menu-focus",
          pid: target.pid,
        });
        const choice = look.nodes.find((node) => node.role === "popUpButton");
        expect(choice).toBeDefined();
        const before = person.states.length;
        await driver.call("click", opens[way as keyof typeof opens](choice!));
        await target.reaches((now) => now.menu === true);
        // AppKit takes key focus before it tracks the menu, so the person's app has the notice by now.
        await person.settled();
        expect(person.states.slice(before - 1)).not.toContainEqual(
          expect.objectContaining({ key: false }),
        );
        expect(person.state).toMatchObject({ key: true, active: true });
        expect(target.state).toMatchObject({ menu: true });
        await driver.call("key", { keys: "Escape" });
        await target.reaches((now) => now.menu === false);
      },
    );
  },
);

describe.skipIf(!EXECUTABLE || process.platform !== "darwin")("the permission guide", () => {
  let driver: AppDriver;
  beforeAll(() => {
    driver = startAppDriver(EXECUTABLE!);
  });
  afterAll(() => driver.close());

  const guide = (preview: boolean) =>
    driver.call("guide", {
      permission: "accessibility",
      bundle: "/System/Applications/Calculator.app",
      title: "Allow it to use apps",
      instruction: "Drag it into the list above",
      preview,
    });

  test("answers at once for what is already granted", async () => {
    expect(await guide(false)).toEqual({ outcome: "granted" });
  });

  test("closes on a cancel that overtakes the guide it ends", async () => {
    const shown = guide(true);
    // The guide's answer is pending: the cancel is answered first, then the guide's own.
    expect(await driver.call("cancelGuide", {})).toEqual({});
    expect(await shown).toEqual({ outcome: "closed" });
  });
});
