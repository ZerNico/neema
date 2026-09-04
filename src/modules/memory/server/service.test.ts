import { describe, expect, it } from "vitest";
import { containsObviousSensitiveValue } from "./service.ts";

describe("memory sensitive-value rejection", () => {
  it.each([
    "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
    "api_key = sk-proj-abcdefghijklmnop",
    "Authorization: Bearer abcdefghijklmnop",
    "password is correct-horse-battery-staple",
    "postgres://user:password@example.com/database",
  ])("rejects an obvious credential: %s", (content) => {
    expect(containsObviousSensitiveValue(content)).toBe(true);
  });

  it.each([
    "AIzaSyB1234567890abcdefghijklmnopqrstuv",
    "GOCSPX-abcdefghijklmnopqrstuv",
    "ya29.a0AfH6SMBabcdefghijklmnopqrstuvwxyz",
    "SG.abcdefghijklmnopqrst.abcdefghijklmnopqrst",
    "npm_abcdefghijklmnopqrstuvwxyz0123456789",
    "AC0123456789abcdef0123456789abcdef",
    "glpat-abcdefghijklmnopqrstuvwx",
    "rk_live_abcdefghijklmnopqrst",
  ])("rejects a vendor API token: %s", (content) => {
    expect(containsObviousSensitiveValue(content)).toBe(true);
  });

  it.each([
    "My card is 4111111111111111",
    "Use 4111 1111 1111 1111 for the subscription",
    "5555-5555-5555-4444",
    "Amex 378282246310005",
    "Discover 6011111111111117",
  ])("rejects a Luhn-valid payment card: %s", (content) => {
    expect(containsObviousSensitiveValue(content)).toBe(true);
  });

  it.each([
    // Same issuer prefixes and lengths, but the Luhn check digit is wrong, so
    // these are ordinary long numbers rather than cards.
    "Order reference 4111111111111112",
    "Invoice 5555555555554443",
    "Ticket 378282246310006",
    // Luhn-valid, but no issuer ever mints these — a 15-digit IMEI and a
    // 13-digit run that starts outside every issuer range.
    "Handset IMEI 356938035643809",
    "Tracking code 1234567890128",
    // Longer than any card, so no window of it is treated as one.
    "Ledger row 41111111111111114111111111111111",
  ])("does not reject a non-card number: %s", (content) => {
    expect(containsObviousSensitiveValue(content)).toBe(false);
  });

  it.each([
    "DE89 3704 0044 0532 0130 00",
    "GB82WEST12345698765432",
    "My salary lands in FR1420041010050500013M02606",
  ])("rejects a checksum-valid IBAN: %s", (content) => {
    expect(containsObviousSensitiveValue(content)).toBe(true);
  });

  it.each([
    // Right shape, wrong mod-97 remainder.
    "DE89 3704 0044 0532 0130 01",
    // Unknown country code — never treated as an IBAN.
    "Ticket AB12 3456 7890 1234",
    // Known country code, wrong length for it.
    "DE89 3704 0044 0532 01",
  ])("does not reject an IBAN-shaped string: %s", (content) => {
    expect(containsObviousSensitiveValue(content)).toBe(false);
  });

  it.each([
    "123-45-6789",
    "SSN: 123 45 6789",
    "My social security number is 123-45-6789",
    "My routing number is 021000021",
    "account number = 000123456789",
    "passport number: 123456789",
  ])("rejects a personal or financial identifier: %s", (content) => {
    expect(containsObviousSensitiveValue(content)).toBe(true);
  });

  it.each([
    // 3-3-4 is a phone number, not an SSN.
    "Call me on 555-123-4567",
    // SSA never issues these prefixes/groups.
    "000-12-3456",
    "123-00-4567",
    // Mixed separators are not the canonical SSN form.
    "123-45 6789",
    // Dates are not identifiers.
    "The sprint runs 2024-05-01 to 2024-05-15",
  ])("does not reject an SSN-shaped string: %s", (content) => {
    expect(containsObviousSensitiveValue(content)).toBe(false);
  });

  it.each([
    "I prefer password managers over memorizing passwords.",
    "My API uses token-based authentication.",
    "I contribute to the private-key documentation project.",
    "I keep my SSN in a password manager, never in notes.",
    "My credit card is in my wallet, not written down.",
    "The CVV is the three digits on the back of the card.",
    "I bank with a credit union and use their IBAN for EU transfers.",
    "AIzaSy is the prefix Google API keys start with.",
    "My conference room booking code is 123 456 7890.",
  ])("does not reject a general preference: %s", (content) => {
    expect(containsObviousSensitiveValue(content)).toBe(false);
  });
});
