import type { JsonValue } from "~/db/schema/providers.ts";

type JsonSchema = Record<string, JsonValue>;

const asSchema = (value: JsonValue | undefined): JsonSchema | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonSchema) : null;

const resolveRef = (schema: JsonSchema, root: JsonSchema): JsonSchema => {
  const ref = schema.$ref;
  if (typeof ref !== "string" || !ref.startsWith("#/$defs/")) return schema;
  const definitions = asSchema(root.$defs);
  return asSchema(definitions?.[ref.slice("#/$defs/".length)]) ?? schema;
};

const exampleFor = (
  input: JsonSchema,
  root: JsonSchema,
  depth: number,
  seen: Set<JsonSchema>,
): JsonValue => {
  const schema = resolveRef(input, root);
  if (seen.has(schema) || depth > 6) return null;
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0]!;
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(alternatives)) {
    // Effect encodes optionality and nullability as unions; pick the first
    // non-null branch so the skeleton shows the useful shape.
    const branch = alternatives.map(asSchema).find((item) => item && item.type !== "null");
    if (branch) return exampleFor(branch, root, depth, seen);
  }
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case "string":
      return typeof schema.description === "string" ? schema.description : "";
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    case "null":
      return null;
    case "array": {
      const items = asSchema(schema.items);
      seen.add(schema);
      const value = items ? [exampleFor(items, root, depth + 1, seen)] : [];
      seen.delete(schema);
      return value;
    }
    case "object": {
      const properties = asSchema(schema.properties);
      if (!properties) return {};
      seen.add(schema);
      const value: Record<string, JsonValue> = {};
      for (const [key, property] of Object.entries(properties)) {
        const child = asSchema(property);
        if (child) value[key] = exampleFor(child, root, depth + 1, seen);
      }
      seen.delete(schema);
      return value;
    }
    default:
      return null;
  }
};

/**
 * A fill-in-the-blanks argument object for a function's provider schema: every
 * property present, strings carrying their own description as a hint, the
 * first enum value chosen. Enough to see what the function wants without
 * reading the schema.
 */
export const exampleArguments = (schema: JsonSchema): string =>
  JSON.stringify(exampleFor(schema, schema, 0, new Set()), null, 2);
