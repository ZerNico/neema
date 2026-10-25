import { describe, expect, it } from "vitest";
import { m } from "~/paraglide/messages.js";
import { availableFeatures, FEATURE_KEYS } from "./features.ts";

describe("feature registry", () => {
  it("reads each feature's words when a page asks for them", () => {
    const [agents] = availableFeatures({ agentsUse: true } as Parameters<
      typeof availableFeatures
    >[0]);
    expect(agents?.title).toBe("Agents");
    expect(agents?.body).toBe(m.help_agents_use_body());
    expect(FEATURE_KEYS).toContain("agents");
  });

  it("counts the tour's features in German", () => {
    expect(m.help_tour_welcome_body({ count: 4 }, { locale: "de" })).toContain(
      "Hier sind die 4 Dinge",
    );
  });
});
