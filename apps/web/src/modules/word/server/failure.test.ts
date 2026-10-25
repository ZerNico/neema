import { describe, expect, it } from "vitest";
import { WordError } from "../errors.ts";
import { wordFailure, wordReadFailure } from "./failure.ts";

describe("a Word failure as a person reads it", () => {
  it("keeps the worker's English and says the same in German", () => {
    const tooLong = wordFailure(
      new WordError(
        "limit",
        "This Word file is too long for a document: it has 12,345 characters, and a document holds 200,000.",
      ),
    );
    expect(tooLong("en")).toBe(
      "This Word file is too long for a document: it has 12,345 characters, and a document holds 200,000.",
    );
    expect(tooLong("de")).toBe(
      "Diese Word-Datei ist zu lang für ein Dokument: Sie hat 12.345 Zeichen, ein Dokument fasst 200.000.",
    );
    const parts = wordFailure(new WordError("limit", "A Word file can have at most 2000 parts."));
    expect(parts("en")).toBe("A Word file can have at most 2000 parts.");
    expect(parts("de")).toBe("Eine Word-Datei darf höchstens 2.000 Bestandteile haben.");
  });

  it("leaves a sentence it does not know in the worker's words", () => {
    const odd = wordFailure(new WordError("invalid_operation", "block 3 is not a table."));
    expect(odd("de")).toBe("block 3 is not a table.");
  });

  it("names the file when anything else went wrong", () => {
    expect(wordReadFailure("Plan.docx", new Error("boom"))("de")).toBe(
      "Plan.docx konnte nicht gelesen werden.",
    );
  });
});
