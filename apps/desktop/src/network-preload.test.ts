import { describe, expect, it, vi } from "vitest";
import { NETWORK_LIST, NETWORK_REVOKE } from "@chat/desktop-rpc";
import { makeNetworkBridge } from "./network-preload.ts";

describe("network preload", () => {
  it("uses the dedicated channels with a host-only revocation", async () => {
    const grants = [{ host: "example.com" }];
    const invoke = vi.fn().mockResolvedValueOnce(grants).mockResolvedValueOnce(undefined);
    const network = makeNetworkBridge({ invoke });

    expect(await network.list()).toEqual(grants);
    await network.revoke("example.com");
    expect(invoke).toHaveBeenNthCalledWith(1, NETWORK_LIST);
    expect(invoke).toHaveBeenNthCalledWith(2, NETWORK_REVOKE, {
      host: "example.com",
    });
  });
});
