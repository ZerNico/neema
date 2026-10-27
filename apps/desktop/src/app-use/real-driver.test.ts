import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type AppDriver, AppDriverError, startAppDriver } from "./driver.ts";
import { buildOutline } from "./outline.ts";

/**
 * The platform's real driver against a real app, opt-in because it opens Calculator and needs
 * the Accessibility and Screen Recording grants: set NEEMA_APP_DRIVER to a built driver
 * (`swift build --package-path native/app-driver/macos`, then `.build/debug/app-driver`).
 */
const EXECUTABLE = process.env.NEEMA_APP_DRIVER;
const CALCULATOR = "com.apple.calculator";

describe.skipIf(!EXECUTABLE || process.platform !== "darwin")("the macOS app driver", () => {
  let driver: AppDriver;

  beforeAll(() => {
    // In the background, so the test also proves nothing it does brings Calculator forward.
    execFileSync("open", ["-g", "-a", "Calculator"]);
    driver = startAppDriver(EXECUTABLE!);
  });
  afterAll(() => driver.close());

  const frontApp = async () => (await driver.call("apps", {})).apps.find((app) => app.front)?.appId;

  const lookAt = async () => {
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

  const press = async (outline: ReturnType<typeof buildOutline>, label: string) => {
    const line = outline.text.split("\n").find((entry) => entry.includes(`button "${label}"`));
    const ref = line?.trim().split(" ")[0];
    expect(ref, label).toBeDefined();
    await driver.call("press", { node: outline.refs.get(ref!)! });
  };

  test("runs on the spawning app's grants", async () => {
    expect(await driver.call("permissions", {})).toEqual({ accessibility: true, capture: true });
  });

  test("presses buttons in the background and reads the result", async () => {
    const front = await frontApp();
    const outline = buildOutline(await lookAt());
    for (const label of ["All Clear", "7", "Multiply", "6", "Equals"]) await press(outline, label);
    const after = buildOutline(await lookAt());
    expect(after.text).toMatch(/text = "42"/);
    expect(await frontApp()).toBe(front);
  });

  test("captures only the window, scaled to fit", async () => {
    const look = await lookAt();
    const png = Buffer.from(look.image.data, "base64");
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(Math.max(look.image.width, look.image.height)).toBeLessThanOrEqual(1280);
    expect(look.image.width / look.image.height).toBeCloseTo(
      look.window.width / look.window.height,
      1,
    );
  });

  test("refuses off-limits apps and stale nodes", async () => {
    await expect(driver.call("look", { appId: "com.apple.Terminal" })).rejects.toMatchObject({
      code: "off_limits",
    });
    await expect(driver.call("press", { node: "n999999" })).rejects.toMatchObject({
      code: "stale_node",
    });
  });
});
