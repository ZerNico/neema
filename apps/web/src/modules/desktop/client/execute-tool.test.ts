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
  name:
    | "run_command"
    | "request_network_access"
    | "request_path_access"
    | "request_local_services"
    | "request_ssh_agent"
    | "read_local_file",
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

  it("asks for a private-network grant only where that alone would help", async () => {
    const violations = ["deny network-outbound git.corp.example:22 private-network"];
    const { client } = clientFor({ exitCode: 0, output: "", truncated: false, violations });
    const result = await execute(client, "run_command", { command: "git fetch" });
    expect(result.ok).toBe(false);
    expect(result.summary).toBe("Network access blocked: git.corp.example:22");
    expect(result.detail).toContain(
      "Call request_network_access for each with privateNetwork true",
    );
  });

  it("fails a command whose tunnel was refused for good, even when it exits 0", async () => {
    const violations = [
      "refused network-outbound example.com:80: Plain HTTP is not supported. Use CONNECT.",
    ];
    const { client } = clientFor({ exitCode: 0, output: "", truncated: false, violations });
    const result = await execute(client, "run_command", { command: "curl http://example.com" });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("no request changes that");
    expect(result.detail).not.toContain("call request_network_access");
  });

  it("points an SSH agent refusal at request_ssh_agent", async () => {
    const violations = [
      "refused network-outbound ssh-agent.invalid:1: This chat has not allowed signing in with the SSH agent.",
    ];
    const { client } = clientFor({ exitCode: 255, output: "", truncated: false, violations });
    const result = await execute(client, "run_command", { command: "git push" });
    expect(result.ok).toBe(false);
    expect(result.summary).toBe("Network access blocked: the SSH agent");
    expect(result.detail).toContain("call request_ssh_agent");
    expect(result.detail).not.toContain("no request changes that");
  });

  it("says when the chat allowed the agent but none was running", async () => {
    const violations = [
      "refused network-outbound ssh-agent.invalid:1: No SSH agent was running on this computer when the command started.",
    ];
    const { client } = clientFor({ exitCode: 255, output: "", truncated: false, violations });
    const result = await execute(client, "run_command", { command: "git push" });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("none was running");
    expect(result.detail).not.toContain("call request_ssh_agent");
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

  it("requests local network services with the chosen scope", async () => {
    const { client, request } = clientFor({ scope: "always" });
    const result = await execute(client, "request_local_services", {}, "always");
    expect(request).toHaveBeenCalledWith("requestCapability", {
      callId: "call",
      conversationId: CONVERSATION,
      generationId: "generation-1",
      capability: "local-services",
      scope: "always",
    });
    expect(result.summary).toBe("Allowed services on this computer for every chat");
  });

  it("asks for the SSH agent for this chat whatever scope was passed", async () => {
    const { client, request } = clientFor({ scope: "chat" });
    const result = await execute(client, "request_ssh_agent", {}, "always");
    expect(request).toHaveBeenCalledWith(
      "requestCapability",
      expect.objectContaining({ capability: "ssh-agent", scope: "chat" }),
    );
    expect(result.summary).toBe("Allowed signing in with SSH keys for this chat");
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

describe("reading a file", () => {
  it("asks for the lines given and says where to read on", async () => {
    const { client, request } = clientFor({
      path: "site/app.log",
      text: "line 3\nline 4\n",
      truncated: true,
      startLine: 3,
      nextLine: 5,
    });
    const result = await execute(client, "read_local_file", {
      path: "/work/site/app.log",
      offset: 3,
      limit: 2,
    });
    expect(request).toHaveBeenCalledWith("readFile", {
      callId: "call",
      conversationId: CONVERSATION,
      path: "/work/site/app.log",
      offset: 3,
      limit: 2,
    });
    expect(result.summary).toBe("Read site/app.log, lines 3–4");
    expect(result.detail).toBe("line 3\nline 4\n\n[More follows: read on with offset 5.]");
  });

  it("reads the whole file when given nothing that could be a line", async () => {
    const { client, request } = clientFor({
      path: "site/a.txt",
      text: "a\n",
      truncated: false,
      startLine: 1,
      lineCount: 1,
    });
    const result = await execute(client, "read_local_file", {
      path: "/work/site/a.txt",
      offset: 0,
    });
    expect(request).toHaveBeenCalledWith("readFile", {
      callId: "call",
      conversationId: CONVERSATION,
      path: "/work/site/a.txt",
    });
    expect(result).toMatchObject({ summary: "Read site/a.txt", detail: "a\n" });
  });

  it("says when the offset is past the end", async () => {
    const { client } = clientFor({
      path: "site/a.txt",
      text: "",
      truncated: false,
      startLine: 9,
      lineCount: 2,
    });
    const result = await execute(client, "read_local_file", {
      path: "/work/site/a.txt",
      offset: 9,
    });
    expect(result.detail).toBe("(site/a.txt has 2 lines, none from line 9 on.)");
  });
});
