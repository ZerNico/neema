import { describe, expect, it } from "vitest";
import { INTEGRATIONS } from "./catalog.ts";
import { integrationToolName, parseIntegrationToolName } from "./manifest.ts";
import { outlineAdapter } from "./outline/server/adapter.ts";
import { ADAPTERS } from "./server/adapters.ts";

describe("integration catalog", () => {
  it("pairs every manifest with an adapter offering exactly its tools", () => {
    expect(ADAPTERS.map((adapter) => adapter.id)).toEqual(INTEGRATIONS.map((entry) => entry.id));
    for (const manifest of INTEGRATIONS) {
      const adapter = ADAPTERS.find((entry) => entry.id === manifest.id)!;
      expect(adapter.tools.map((tool) => tool.name).toSorted()).toEqual(
        manifest.tools.map((tool) => tool.name).toSorted(),
      );
      expect(Boolean(adapter.knowledge)).toBe(manifest.knowledgeSource);
      expect(Boolean(adapter.oauth)).toBe(manifest.oauth !== null);
    }
  });

  it("keeps model-facing names within the common provider limit and reversible", () => {
    for (const manifest of INTEGRATIONS)
      for (const tool of manifest.tools) {
        const name = integrationToolName(manifest.id, tool.name);
        expect(name.length).toBeLessThanOrEqual(64);
        expect(name).toMatch(/^[a-zA-Z0-9_-]+$/);
        expect(parseIntegrationToolName(name)).toEqual({
          integrationId: manifest.id,
          tool: tool.name,
        });
      }
    expect(parseIntegrationToolName("custom_weather__now")).toBeNull();
    expect(parseIntegrationToolName("int_broken")).toBeNull();
  });
});

describe("Outline configuration", () => {
  it("normalizes the address and uses it as the credential fingerprint", () => {
    expect(outlineAdapter.normalizeConfig({ baseUrl: " https://docs.example.com/// " })).toEqual({
      config: { baseUrl: "https://docs.example.com" },
      fingerprint: "https://docs.example.com",
    });
    expect(outlineAdapter.normalizeConfig({ baseUrl: "http://10.0.0.5:3000/wiki/" })).toEqual({
      config: { baseUrl: "http://10.0.0.5:3000/wiki" },
      fingerprint: "http://10.0.0.5:3000/wiki",
    });
  });

  it("refuses anything that is not an http(s) address", () => {
    expect(outlineAdapter.normalizeConfig({ baseUrl: "" })).toHaveProperty("error");
    expect(outlineAdapter.normalizeConfig({ baseUrl: "file:///etc" })).toHaveProperty("error");
  });
});
