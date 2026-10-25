import { describe, expect, it } from "vitest";
import { english } from "~/i18n/localized.ts";
import { ToolUnavailable, unavailableReason } from "./tool-unavailable.ts";

describe("unavailableReason", () => {
  it("words each refused tool as its own sentence", () => {
    const off = unavailableReason(new ToolUnavailable({ tool: "web_search", reason: "disabled" }));
    expect(english(off)).toBe("Web search is turned off");
    expect(off("de")).toBe("Die Websuche ist ausgeschaltet");
    const research = unavailableReason(
      new ToolUnavailable({ tool: "deep_research", reason: "web search is not permitted" }),
    );
    expect(research("de")).toBe("Die Recherche braucht die Websuche, die du nicht nutzen darfst");
  });

  it("keeps an unknown reason readable", () => {
    const other = unavailableReason(new ToolUnavailable({ tool: "web_search", reason: "odd" }));
    expect(english(other)).toBe("Web search unavailable: odd");
  });
});
