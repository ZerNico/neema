import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { Schema } from "effect";

/**
 * An Effect schema as the MCP SDK takes one: it validates arguments through
 * `~standard.validate` and advertises them through `~standard.jsonSchema`.
 * Effect gives each half separately, so they are joined here.
 */
export const toolInput = <S extends Schema.Codec<unknown, unknown, never, never>>(
  schema: S,
): StandardSchemaWithJSON<S["Encoded"], S["Type"]> => ({
  "~standard": {
    ...Schema.toStandardSchemaV1(schema)["~standard"],
    jsonSchema: Schema.toStandardJSONSchemaV1(schema)["~standard"].jsonSchema,
  },
});
