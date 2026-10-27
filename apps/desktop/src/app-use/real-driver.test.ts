import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { type AppDriver, AppDriverError, startAppDriver } from "./driver.ts";
import { buildOutline } from "./outline.ts";
import type { Look } from "./protocol.ts";

/**
 * The platform's real driver against a real app, opt-in because it opens Calculator and needs
 * the Accessibility and Screen Recording grants: set NEEMA_APP_DRIVER to a built driver
 * (`swift build --package-path native/app-driver/macos`, then `.build/debug/app-driver`).
 * Every action must leave the front app in front: app use works behind the person's back.
 */
const EXECUTABLE = process.env.NEEMA_APP_DRIVER;
const CALCULATOR = "com.apple.calculator";

describe.skipIf(!EXECUTABLE || process.platform !== "darwin")("the macOS app driver", () => {
  let driver: AppDriver;
  let front: string | undefined;

  const frontApp = async () => (await driver.call("apps", {})).apps.find((app) => app.front)?.appId;

  const lookAt = async (): Promise<Look> => {
    // Opening is asynchronous; the window appears a moment after `open` returns.
    for (;;) {
      try {
        return await driver.call("look", { appId: CALCULATOR });
      } catch (error) {
        if (!(error instanceof AppDriverError && /no_window|not_running/.test(error.code))) {
          throw error;
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
  };

  const display = (look: Look) =>
    look.nodes
      .filter((node) => node.role === "text")
      .map((node) => node.value?.replace(/\p{Cf}/gu, ""))
      .at(-1);

  const button = (look: Look, name: string) => {
    const node = look.nodes.find((entry) => entry.role === "button" && entry.name === name);
    expect(node?.frame, name).toBeDefined();
    return node!;
  };

  beforeAll(async () => {
    driver = startAppDriver(EXECUTABLE!);
    await driver.call("open", { appId: CALCULATOR });
    front = await frontApp();
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
    expect(display(await lookAt())).toBe("42");
    expect(await frontApp()).toBe(front);
  });

  test("clicks by coordinate in the background", async () => {
    const look = await lookAt();
    for (const name of ["7", "Multiply", "8", "Equals"]) {
      const { frame } = button(look, name);
      await driver.call("click", {
        at: { x: frame!.x + frame!.width / 2, y: frame!.y + frame!.height / 2 },
      });
    }
    expect(display(await lookAt())).toBe("56");
    expect(await frontApp()).toBe(front);
  });

  test("types and presses keys in the background", async () => {
    await driver.call("type", { text: "12+30" });
    await driver.call("key", { keys: "Return" });
    expect(display(await lookAt())).toBe("42");
    expect(await frontApp()).toBe(front);
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
