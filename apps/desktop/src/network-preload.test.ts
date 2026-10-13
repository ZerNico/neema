import { describe, expect, it, vi } from "vitest";
import { NETWORK_LIST, NETWORK_REVOKE, PATHS_LIST, PATHS_REVOKE } from "@chat/desktop-rpc";
import { makeNetworkBridge } from "./network-preload.ts";

describe("network preload", () => {
  it("uses the dedicated channels and sends only the grant's own fields", async () => {
    const grants = [{ host: "github.com", port: 22, privateNetwork: false }];
    const invoke = vi.fn().mockResolvedValueOnce(grants).mockResolvedValue(undefined);
    const network = makeNetworkBridge({ invoke });

    expect(await network.list()).toEqual(grants);
    await network.revoke({ ...grants[0]!, extra: "dropped" } as (typeof grants)[0]);
    await network.listPaths();
    await network.revokePath("/opt/specs");
    expect(invoke.mock.calls).toEqual([
      [NETWORK_LIST],
      [NETWORK_REVOKE, { host: "github.com", port: 22, privateNetwork: false }],
      [PATHS_LIST],
      [PATHS_REVOKE, { path: "/opt/specs" }],
    ]);
  });
});
