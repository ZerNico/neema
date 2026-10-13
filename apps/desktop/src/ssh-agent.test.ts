import { describe, expect, it } from "vitest";
import { agentFromConfig, findAgent, type AgentLookup } from "./ssh-agent.ts";

const env = { SSH_AUTH_SOCK: "/tmp/launchd/Listeners", OP_AGENT: "/tmp/op.sock" };

describe("agentFromConfig", () => {
  it("takes the IdentityAgent the user's config names", () => {
    const output = "user me\nidentityagent /Users/me/Library/Group Containers/op/agent.sock\n";
    expect(agentFromConfig(output, env)).toBe("/Users/me/Library/Group Containers/op/agent.sock");
  });

  it("falls back to SSH_AUTH_SOCK when the config names none or names that variable", () => {
    expect(agentFromConfig("user me\n", env)).toBe("/tmp/launchd/Listeners");
    expect(agentFromConfig("identityagent SSH_AUTH_SOCK\r\n", env)).toBe("/tmp/launchd/Listeners");
    expect(agentFromConfig("user me\n", {})).toBeNull();
  });

  it("reads another variable, and honours none", () => {
    expect(agentFromConfig("identityagent $OP_AGENT\n", env)).toBe("/tmp/op.sock");
    expect(agentFromConfig("identityagent none\n", env)).toBeNull();
  });
});

const lookup = (overrides: Partial<AgentLookup>): AgentLookup => ({
  env,
  ssh: "/usr/bin/ssh",
  config: async () => "user me\n",
  exists: async () => true,
  ...overrides,
});

describe("findAgent", () => {
  it("asks the user's ssh which agent its config uses", async () => {
    expect(
      await findAgent(lookup({ config: async () => "identityagent /tmp/secretive.sock\n" })),
    ).toBe("/tmp/secretive.sock");
  });

  it("uses SSH_AUTH_SOCK when there is no ssh to ask or asking fails", async () => {
    expect(await findAgent(lookup({ ssh: null }))).toBe("/tmp/launchd/Listeners");
    expect(
      await findAgent(
        lookup({
          config: async () => {
            throw new Error("timed out");
          },
        }),
      ),
    ).toBe("/tmp/launchd/Listeners");
  });

  it("offers nothing for an agent that is not running", async () => {
    expect(await findAgent(lookup({ exists: async () => false }))).toBeNull();
  });
});
