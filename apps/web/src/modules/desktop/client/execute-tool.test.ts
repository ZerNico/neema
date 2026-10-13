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

const CONVERSATION = "019a574e-9415-7463-8431-11ef4a8f9b6a";

const execute = (
  client: ReturnType<typeof clientFor>["client"],
  name: "run_command" | "request_network_access" | "request_path_access",
  args: Record<string, unknown>,
  scope: "answer" | "chat" | "always" = "answer",
) =>
  Effect.runPromise(
    executeDesktopTool(client, CONVERSATION, 120_000, {
      callId: "call",
      generationId: "generation-1",
      name,
      args,
      scope,
    }),
  );

const permission = { host: "example.com", port: 443, privateNetwork: false, scope: "answer" };

describe("desktop network tools", () => {
  it("requests a host on 443 for this answer by default", async () => {
    const { client, request } = clientFor(permission);
    const result = await execute(client, "request_network_access", { host: "example.com" });
    expect(request).toHaveBeenCalledWith("requestNetworkAccess", {
      callId: "call",
      conversationId: CONVERSATION,
      generationId: "generation-1",
      host: "example.com",
      port: 443,
      privateNetwork: false,
      scope: "answer",
    });
    expect(result).toMatchObject({
      ok: true,
      summary: "Allowed example.com:443 for this answer",
      detail:
        "The user allowed example.com:443 for this answer. You may now run or retry the command.",
    });
  });

  it("passes the port, private network flag and chosen scope", async () => {
    const { client, request } = clientFor({
      host: "git.internal",
      port: 22,
      privateNetwork: true,
      scope: "chat",
    });
    const result = await execute(
      client,
      "request_network_access",
      { host: "git.internal", port: 22, privateNetwork: true },
      "chat",
    );
    expect(request).toHaveBeenCalledWith(
      "requestNetworkAccess",
      expect.objectContaining({ port: 22, privateNetwork: true, scope: "chat" }),
    );
    expect(result.summary).toBe("Allowed git.internal:22 for this chat");
  });

  it.each([{}, { host: 443 }, { host: "" }])("refuses a missing host: %j", async (args) => {
    const { client, request } = clientFor(permission);
    const result = await execute(client, "request_network_access", args);
    expect(result).toMatchObject({ ok: false, detail: "Name a host." });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([0, 65_536, 22.5, "22"])("refuses an invalid port: %j", async (port) => {
    const { client, request } = clientFor(permission);
    const result = await execute(client, "request_network_access", { host: "example.com", port });
    expect(result.ok).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it("offers a request for every blocked destination while preserving raw data", async () => {
    const violations = [
      "deny network-outbound api.example.com:443",
      "deny network-outbound api.example.com:443",
      "deny network-outbound github.com:22",
    ];
    const output = "Connection failed to api.example.com:443";
    const { client } = clientFor({ exitCode: 7, output, truncated: false, violations });
    const result = await execute(client, "run_command", { command: "git fetch" });
    expect(result.ok).toBe(false);
    expect(result.summary).toBe("Network access blocked: api.example.com:443, github.com:22");
    expect(result.detail).toContain(
      "Call request_network_access for each with its host and port, wait for approval, then retry the command.",
    );
    expect(result.detail).toContain(output);
    expect(result.violations).toEqual(violations);
  });

  it("sends the answer's id with a command", async () => {
    const { client, request } = clientFor({
      exitCode: 0,
      output: "",
      truncated: false,
      violations: [],
    });
    await execute(client, "run_command", { command: "true" });
    expect(request).toHaveBeenCalledWith(
      "runCommand",
      expect.objectContaining({ generationId: "generation-1" }),
    );
  });

  it("requests read access to a path with the chosen scope", async () => {
    const { client, request } = clientFor({ path: "/opt/specs", scope: "chat" });
    const result = await execute(client, "request_path_access", { path: "/opt/specs" }, "chat");
    expect(request).toHaveBeenCalledWith("requestPathAccess", {
      callId: "call",
      conversationId: CONVERSATION,
      generationId: "generation-1",
      path: "/opt/specs",
      scope: "chat",
    });
    expect(result.summary).toBe("Allowed reading /opt/specs for this chat");
  });

  it("refuses a path request without a path", async () => {
    const { client, request } = clientFor({ path: "/opt", scope: "answer" });
    const result = await execute(client, "request_path_access", {});
    expect(result.ok).toBe(false);
    expect(request).not.toHaveBeenCalled();
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
