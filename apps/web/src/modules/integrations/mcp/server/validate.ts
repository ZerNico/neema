import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";

type Check = ReturnType<AjvJsonSchemaValidator["getValidator"]>;

/** Enough for every enabled tool of a few busy servers. */
const MAX_COMPILED = 512;

/**
 * AJV keeps every schema it compiled, so a bounded cache of our own does
 * not bound memory. Instead the whole validator is replaced once it has
 * compiled this many, and what it held goes with it.
 */
let validator = new AjvJsonSchemaValidator();
let compiled = new Map<string, Check | { error: string }>();

/**
 * A tool's argument check, compiled once per fingerprint. A schema the
 * validator cannot compile (a broken pattern, an unknown keyword in strict
 * mode) is an answer too, never a thrown defect. `$async` is dropped while
 * listing: an async check would hand back a promise the SDK reads as valid.
 */
export const argumentCheck = (fingerprint: string, schema: Readonly<Record<string, unknown>>) => {
  const known = compiled.get(fingerprint);
  if (known) return known;
  if (compiled.size >= MAX_COMPILED) {
    validator = new AjvJsonSchemaValidator();
    compiled = new Map();
  }
  let made: Check | { error: string };
  try {
    made = validator.getValidator(schema as Parameters<AjvJsonSchemaValidator["getValidator"]>[0]);
  } catch {
    made = { error: "Its input schema is not valid JSON Schema." };
  }
  compiled.set(fingerprint, made);
  return made;
};
