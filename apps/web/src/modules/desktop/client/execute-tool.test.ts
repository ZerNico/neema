import { makeDesktopClient, PROTOCOL_VERSION } from "@chat/desktop-rpc";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { executeDesktopTool } from "./execute-tool.ts";

const clientFor = (reply: unknown) => {
  const request = vi.fn(async (_tag: string, _payload: unknown) => ({
    ok: true as const,
    value: reply,
  }));
  return {
    client: makeDesktopClient({
      protocolVersion: PROTOCOL_VERSION,
      stageDroppedFile: async () => null,
      request,
    }),
    request,
  };
};

const execute = (
  client: ReturnType<typeof clientFor>["client"],
  name: "run_command" | "request_network_access",
  args: Record<string, unknown>,
) =>
  Effect.runPromise(
    executeDesktopTool(client, "019a574e-9415-7463-8431-11ef4a8f9b6a", 120_000, {
      callId: "call",
      name,
      args,
    }),
  );

describe("desktop network tools", () => {
  it("requests only a website host and reports the host-only grant", async () => {
    const { client, request } = clientFor({ host: "example.com" });
    const result = await execute(client, "request_network_access", {
      host: "example.com",
    });
    expect(request).toHaveBeenCalledWith("requestNetworkAccess", {
      callId: "call",
      conversationId: "019a574e-9415-7463-8431-11ef4a8f9b6a",
      host: "example.com",
    });
    expect(result).toMatchObject({
      ok: true,
      summary: "Allowed network access to example.com",
      detail: "The user allowed example.com. You may now run or retry the command.",
    });
  });

  it.each([{}, { host: 443 }, { host: "" }])("refuses a missing website host: %j", async (args) => {
    const { client, request } = clientFor({ host: "example.com" });
    const result = await execute(client, "request_network_access", args);
    expect(result).toMatchObject({ ok: false, detail: "Name a website host." });
    expect(request).not.toHaveBeenCalled();
  });

  it("offers host-only guidance for blocked HTTPS websites while preserving raw data", async () => {
    const violations = [
      "deny network-outbound api.example.com:443 (host is not on the allow list)",
      "deny network-outbound api.example.com:443 (host is not on the allow list)",
      "deny network-outbound cdn.example.com:443 (host is not on the allow list)",
    ];
    const output = "Connection failed to api.example.com:443";
    const { client } = clientFor({ exitCode: 7, output, truncated: false, violations });
    const result = await execute(client, "run_command", {
      command: "curl https://api.example.com",
    });
    expect(result.ok).toBe(false);
    expect(result.summary).toBe("Network access blocked: api.example.com, cdn.example.com");
    expect(result.detail).toContain(
      "Call request_network_access separately with only the host for api.example.com, cdn.example.com",
    );
    expect(result.detail).toContain("then retry the command");
    expect(result.detail).toContain(output);
    expect(result.violations).toEqual(violations);
  });

  it.each([80, 8443])("does not offer website approval for blocked port %s", async (port) => {
    const violations = [
      `deny network-outbound api.example.com:${port} (host is not on the allow list)`,
    ];
    const { client } = clientFor({
      exitCode: 0,
      output: "partial result",
      truncated: false,
      violations,
    });
    const result = await execute(client, "run_command", { command: "fetch data" });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain(`api.example.com:${port}`);
    expect(result.detail).toContain("unsupported ports; website approval cannot authorize them");
    expect(result.detail).not.toContain("request_network_access");
    expect(result.detail).toContain("partial result");
    expect(result.violations).toEqual(violations);
  });

  it("reports non-HTTPS denials as unsupported regardless of the denial reason", async () => {
    const violations = ["deny network-outbound api.example.com:8443 (port is not allowed)"];
    const { client } = clientFor({ exitCode: 1, output: "", truncated: false, violations });
    const result = await execute(client, "run_command", { command: "fetch data" });
    expect(result.detail).toContain("unsupported ports; website approval cannot authorize them");
    expect(result.detail).not.toContain("request_network_access");
    expect(result.violations).toEqual(violations);
  });

  it("does not offer approval for unrelated HTTPS denials", async () => {
    const { client } = clientFor({
      exitCode: 1,
      output: "Connection failed",
      truncated: false,
      violations: ["deny network-outbound api.example.com:443 (private address is blocked)"],
    });
    const result = await execute(client, "run_command", { command: "fetch data" });
    expect(result.detail).not.toContain("request_network_access");
  });

  it("limits request guidance to HTTPS hosts when a command has mixed denials", async () => {
    const { client } = clientFor({
      exitCode: 7,
      output: "Connection failed",
      truncated: false,
      violations: [
        "deny network-outbound api.example.com:443 (host is not on the allow list)",
        "deny network-outbound other.example.com:8080 (host is not on the allow list)",
      ],
    });
    const result = await execute(client, "run_command", { command: "fetch data" });
    expect(result.detail).toContain(
      "Call request_network_access separately with only the host for api.example.com, wait for approval",
    );
    expect(result.detail).toContain(
      "Network access to other.example.com:8080 was blocked. These destinations use unsupported ports",
    );
  });

  it("does not infer network access from unrelated denials", async () => {
    const { client } = clientFor({
      exitCode: 1,
      output: "Permission denied",
      truncated: false,
      violations: ["deny file-write /tmp/example.com:443"],
    });
    const result = await execute(client, "run_command", { command: "touch /tmp/example.com:443" });
    expect(result.detail).not.toContain("request_network_access");
    expect(result.violations).toEqual(["deny file-write /tmp/example.com:443"]);
  });
});
