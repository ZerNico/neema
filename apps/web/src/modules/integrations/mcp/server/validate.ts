import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";

const validator = new AjvJsonSchemaValidator();
type Check = ReturnType<typeof validator.getValidator>;

/** Enough for every enabled tool of a few busy servers; the oldest go first. */
const MAX_COMPILED = 512;
const compiled = new Map<string, Check | { error: string }>();

/**
 * A tool's argument check, compiled once per fingerprint. A schema the
 * validator cannot compile (a broken pattern, an unknown keyword in strict
 * mode) is an answer too, never a thrown defect.
 */
export const argumentCheck = (fingerprint: string, schema: Readonly<Record<string, unknown>>) => {
  const known = compiled.get(fingerprint);
  if (known) {
    compiled.delete(fingerprint);
    compiled.set(fingerprint, known);
    return known;
  }
  let made: Check | { error: string };
  try {
    made = validator.getValidator(schema as Parameters<typeof validator.getValidator>[0]);
  } catch {
    made = { error: "Its input schema is not valid JSON Schema." };
  }
  compiled.set(fingerprint, made);
  if (compiled.size > MAX_COMPILED) compiled.delete(compiled.keys().next().value!);
  return made;
};
