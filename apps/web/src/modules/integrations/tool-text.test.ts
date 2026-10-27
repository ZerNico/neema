import { describe, expect, it } from "vitest";
import { approvalConsequence, type PendingIntegrationCall } from "./schema.ts";
import { approvalAction, toolText } from "./tool-text.ts";

const call = (overrides: Partial<PendingIntegrationCall>): PendingIntegrationCall => ({
  kind: "approval",
  callId: "c1",
  conversationId: "chat",
  messageId: "m1",
  integrationId: "mail",
  connectionId: "k1",
  account: null,
  tool: "send_mail",
  label: "Sent an Outlook message",
  access: "destructive",
  summary: null,
  targets: [],
  promptId: "p1",
  expiresAt: 0,
  ...overrides,
});

describe("a shipped tool's words", () => {
  it("reads in the given language, and a server's own tool keeps its words", () => {
    const sent = { name: "send_mail", title: "Send mail", label: "Sent an Outlook message" };
    expect(toolText("outlook", sent, "en").label).toBe("Sent an Outlook message");
    expect(toolText("outlook", sent, "de")).toEqual({
      title: "Mails senden",
      label: "Outlook-Nachricht gesendet",
    });
    expect(toolText("mcp", { name: "search", title: "Search docs" }, "de").title).toBe(
      "Search docs",
    );
  });
});

describe("approvalAction", () => {
  it("asks with a shipped tool's action, never its past-tense transcript label", () => {
    expect(approvalAction("outlook", call({}), "en")).toBe("Send mail");
    expect(approvalAction("outlook", call({}), "de")).toBe("Mails senden");
  });

  it("keeps a server's own words for its tool, which the call carries as its label", () => {
    expect(approvalAction("mcp", call({ tool: "create_issue", label: "Create issue" }), "en")).toBe(
      "Create issue",
    );
  });
});

describe("approvalConsequence", () => {
  it("counts the people a call would contact, in either language", () => {
    const one = call({ targets: ["ana@example.com"] });
    const two = call({ targets: ["ana@example.com", "bo@example.com"], account: "Work" });
    expect(approvalConsequence(one, "Outlook", "en")).toBe(
      "This will contact this person from your Outlook account.",
    );
    expect(approvalConsequence(two, "Outlook", "en")).toBe(
      "This will contact these 2 people from your Outlook account “Work”.",
    );
    expect(approvalConsequence(two, "Outlook", "de")).toBe(
      "Dabei werden diese 2 Personen über dein Konto „Work“ bei Outlook kontaktiert.",
    );
    expect(approvalConsequence(call({ access: "read" }), "Jira", "de")).toBe(
      "Dabei wird mit deinem Konto bei Jira gelesen.",
    );
  });
});
