import { describe, expect, it, vi } from "vitest";
import { createOwnerLimit } from "./owner-limit.ts";

const limit = () =>
  createOwnerLimit({
    perOwner: 1,
    queue: 1,
    busy: () => new Error("busy"),
    cancelled: () => new Error("cancelled"),
  });

describe("owner admission", () => {
  it.each(["owner", undefined])(
    "refuses a pre-aborted free request before invoking work (%s)",
    async (owner) => {
      const owners = limit();
      const controller = new AbortController();
      controller.abort();
      const work = vi.fn(async () => "work");
      await expect(owners.run(owner, controller.signal, work)).rejects.toThrow("cancelled");
      expect(work).not.toHaveBeenCalled();
      await expect(owners.run(owner, undefined, work)).resolves.toBe("work");
    },
  );

  it("leaves the waiting place available after a pre-aborted request", async () => {
    const owners = limit();
    const entered = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const active = owners.run("owner", undefined, () => {
      entered.resolve();
      return held.promise;
    });
    await entered.promise;
    const controller = new AbortController();
    controller.abort();
    const cancelledWork = vi.fn(async () => "cancelled");
    await expect(owners.run("owner", controller.signal, cancelledWork)).rejects.toThrow(
      "cancelled",
    );
    const useful = owners.run("owner", undefined, async () => "useful");
    held.resolve();
    await active;
    await expect(useful).resolves.toBe("useful");
    expect(cancelledWork).not.toHaveBeenCalled();
  });

  it.each(["abort-first", "release-first"])(
    "releases a cancelled wait without running it (%s)",
    async (order) => {
      const owners = limit();
      const entered = Promise.withResolvers<void>();
      const held = Promise.withResolvers<void>();
      const active = owners.run("owner", undefined, () => {
        entered.resolve();
        return held.promise;
      });
      await entered.promise;
      const controller = new AbortController();
      const work = vi.fn(async () => "cancelled");
      const waiting = owners.run("owner", controller.signal, work);
      const refused = expect(waiting).rejects.toThrow("cancelled");
      if (order === "abort-first") {
        controller.abort();
        held.resolve();
      } else {
        held.resolve();
        // Let release transfer the slot, but abort before the admitted continuation runs.
        await held.promise;
        controller.abort();
      }
      await active;
      await refused;
      expect(work).not.toHaveBeenCalled();
      await expect(owners.run("owner", undefined, async () => "next")).resolves.toBe("next");
    },
  );
});
