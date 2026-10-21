import { Tool } from "effect/unstable/ai";

type JsonSchema = Record<string, unknown>;

const isSchema = (value: unknown): value is JsonSchema =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether a value valid under `schema` can never be `""`. Unsure reads as false. */
const rejectsEmpty = (schema: unknown, defs: JsonSchema, depth = 0): boolean => {
  if (!isSchema(schema) || depth > 8) return false;
  const ref = schema.$ref;
  if (typeof ref === "string")
    return ref.startsWith("#/$defs/") && rejectsEmpty(defs[ref.slice(8)], defs, depth + 1);
  const all = (key: string) =>
    Array.isArray(schema[key]) &&
    (schema[key] as unknown[]).every((branch) => rejectsEmpty(branch, defs, depth + 1));
  if (all("anyOf") || all("oneOf")) return true;
  if (
    Array.isArray(schema.allOf) &&
    schema.allOf.some((branch) => rejectsEmpty(branch, defs, depth + 1))
  )
    return true;
  if ("const" in schema) return schema.const !== "";
  if (Array.isArray(schema.enum)) return !schema.enum.includes("");
  const type = schema.type;
  if (typeof type === "string" && type !== "string") return true;
  if (Array.isArray(type) && !type.includes("string")) return true;
  if (typeof schema.minLength === "number" && schema.minLength > 0) return true;
  if (typeof schema.format === "string") return true;
  if (typeof schema.pattern === "string") {
    try {
      return !new RegExp(schema.pattern, "u").test("");
    } catch {
      return false;
    }
  }
  return false;
};

/**
 * Some models fill every key they are offered and write an optional one they
 * mean to leave out as `""`. Where the advertised schema cannot take `""`, that
 * key is dropped, so the call decodes as the model meant it instead of failing
 * the generation or looping on a correction it repeats. A required key, or one
 * where `""` is a value, is left as written.
 */
export const dropEmptyOptionals = (params: unknown, schema: unknown): unknown => {
  if (!isSchema(params) || !isSchema(schema) || !isSchema(schema.properties)) return params;
  const properties = schema.properties;
  const required = Array.isArray(schema.required) ? schema.required : [];
  const defs = isSchema(schema.$defs) ? schema.$defs : {};
  const dropped = Object.keys(params).filter(
    (key) =>
      params[key] === "" &&
      !required.includes(key) &&
      key in properties &&
      rejectsEmpty(properties[key], defs),
  );
  if (!dropped.length) return params;
  return Object.fromEntries(Object.entries(params).filter(([key]) => !dropped.includes(key)));
};

/** `dropEmptyOptionals` for calls to a set of tools, each schema built once and only when needed. */
export const emptyOptionalsDropper = (tools: ReadonlyArray<Tool.Any>) => {
  const schemas = new Map<string, unknown>();
  return (name: string, params: unknown): unknown => {
    if (!isSchema(params) || !Object.values(params).includes("")) return params;
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) return params;
    if (!schemas.has(name)) schemas.set(name, Tool.getJsonSchema(tool));
    return dropEmptyOptionals(params, schemas.get(name));
  };
};
