import { describe, expect, it } from "vitest";
import {
  challengeOf,
  createVerifier,
  formatTicket,
  generateTicket,
  hashTicket,
  isTicketShaped,
  normaliseTicket,
  TICKET_ALPHABET,
  TICKET_LENGTH,
} from "./desktop-ticket.ts";

describe("desktop ticket helpers", () => {
  it("generates 20 characters from the unambiguous alphabet", () => {
    for (let i = 0; i < 50; i++) {
      const ticket = generateTicket();
      expect(ticket).toHaveLength(TICKET_LENGTH);
      for (const c of ticket) expect(TICKET_ALPHABET).toContain(c);
      expect(ticket).not.toMatch(/[0O1ILU]/);
      expect(isTicketShaped(ticket)).toBe(true);
    }
    expect(generateTicket()).not.toBe(generateTicket());
  });

  it("formats in groups of five and normalises what a user types back", () => {
    const ticket = "K7MX4QPD9RTA2HCVB3N5";
    expect(formatTicket(ticket)).toBe("K7MX4-QPD9R-TA2HC-VB3N5");
    expect(normaliseTicket(" k7mx4-qpd9r ta2hc_vb3n5\n")).toBe(ticket);
    expect(normaliseTicket(formatTicket(ticket))).toBe(ticket);
  });

  it("rejects codes of the wrong length or with letters outside the alphabet", () => {
    expect(isTicketShaped("K7MX4QPD9RTA2HCVB3N")).toBe(false);
    expect(isTicketShaped("K7MX4QPD9RTA2HCVB3N50")).toBe(false);
    expect(isTicketShaped("07MX4QPD9RTA2HCVB3N5")).toBe(false);
  });

  it("hashes tickets with sha256 hex, independent of how they were typed", async () => {
    const hash = await hashTicket("K7MX4QPD9RTA2HCVB3N5");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashTicket(normaliseTicket("k7mx4-qpd9r-ta2hc-vb3n5"))).toBe(hash);
    expect(await hashTicket("K7MX4QPD9RTA2HCVB3N6")).not.toBe(hash);
  });

  it("derives the RFC 7636 S256 challenge from a verifier", async () => {
    // Example vector from RFC 7636 appendix B.
    expect(await challengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
    const verifier = createVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createVerifier()).not.toBe(verifier);
  });
});
