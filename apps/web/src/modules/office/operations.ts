// Worker processes load this file without the `~` alias; keep imports relative.
import type { JobError } from "../../server/job-worker.ts";

/**
 * The engine behind every Office family's operation table. A family declares
 * its edits once, as fields; validation, the JSON schema the model is offered
 * and the activity's change summary all derive from that table here, so the
 * three cannot drift apart. A family adds only its own field kinds (a cell
 * range, a slide ref, a picture) and the checks that span fields.
 */
export type JsonSchema = Record<string, unknown>;

/** Field kinds every family shares; a family's own kinds must use other names. */
export type SharedField<C> =
  | {
      readonly type: "integer" | "number";
      readonly min: number;
      readonly max: number;
      readonly about: string;
    }
  | { readonly type: "boolean"; readonly about: string }
  | {
      readonly type: "string";
      readonly max: number;
      readonly about: string;
      readonly options?: readonly string[];
      readonly pattern?: string;
    }
  | {
      readonly type: "list";
      readonly of: Field<C>;
      readonly min: number;
      readonly max: number;
      readonly about: string;
    }
  | ObjectField<C>;
type ObjectField<C> = {
  readonly type: "object";
  readonly about: string;
} & Shape<C>;
export type Field<C> = SharedField<C> | C;

interface Shape<C> {
  readonly fields: Readonly<Record<string, Field<C>>>;
  readonly required: readonly string[];
  /** Each group names alternatives of which exactly one must be present. */
  readonly exclusive?: readonly (readonly string[])[];
}
export interface Definition<C> extends Shape<C> {
  readonly about: string;
  /** Past-tense verb and counted noun for the activity summary. */
  readonly change: readonly [verb: string, noun?: string];
}

const SHARED = new Set(["integer", "number", "boolean", "string", "list", "object"]);

export const received = (raw: unknown) =>
  raw === null
    ? "null"
    : Array.isArray(raw)
      ? "an array"
      : typeof raw === "number"
        ? `the number ${raw}`
        : typeof raw === "string"
          ? "a string"
          : `a ${typeof raw}`;

/**
 * XML can't carry C0 controls other than tab, newline and return, a lone
 * surrogate half, nor U+FFFE/U+FFFF. Iterating by code point keeps a valid
 * pair whole, so only an unpaired half is seen on its own.
 */
export const xmlSafe = (text: string) =>
  ![...text].some((character) => {
    const code = character.codePointAt(0)!;
    return (
      (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
      (code >= 0xd800 && code <= 0xdfff) ||
      code === 0xfffe ||
      code === 0xffff
    );
  });

const decimal = /^-?\d+(?:\.\d+)?$/;

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const article = (noun: string) => (/^[aeiou]/.test(noun) ? `an ${noun}` : `a ${noun}`);
const plural = (noun: string) => (noun.endsWith("s") ? noun : `${noun}s`);
const listed = (items: readonly string[]) =>
  items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : (items[0] ?? "");

/** What a family's own field kinds need: how each reads, validates and is advertised. */
export interface OwnFields<C, S> {
  describe(field: C): string;
  /** `wrong` fails with the field's description and what was received. */
  value(field: C, raw: unknown, path: string, stage: S, wrong: () => never): unknown;
  schema(field: C): JsonSchema;
}

export function operationEngine<
  C extends { readonly type: string; readonly about: string },
  S = undefined,
>(config: {
  readonly operations: Readonly<Record<string, Definition<C>>>;
  readonly maxOperations: number;
  readonly Error: new (code: string, message: string) => JobError;
  readonly own: OwnFields<C, S>;
  /** How the operations parameter introduces itself to the model. */
  readonly description?: string;
}) {
  const { operations: table, own } = config;
  const fail = (path: string, message: string): never => {
    throw new config.Error("invalid_operation", `${path}: ${message}`);
  };
  const shared = (field: Field<C>): field is SharedField<C> => SHARED.has(field.type);

  const describe = (field: Field<C>): string => {
    if (!shared(field)) return own.describe(field);
    switch (field.type) {
      case "integer":
        return `an integer from ${field.min} to ${field.max}`;
      case "number":
        return `a number from ${field.min} to ${field.max}`;
      case "boolean":
        return "true or false";
      case "string":
        return field.options
          ? `one of ${field.options.join(", ")}`
          : field.pattern
            ? field.about
            : `text up to ${field.max} characters`;
      case "list":
        return `a list of ${field.min}–${field.max} items`;
      case "object":
        return "an object";
    }
  };

  function value(field: Field<C>, raw: unknown, path: string, stage: S): unknown {
    const wrong = () => fail(path, `expected ${describe(field)}; received ${received(raw)}`);
    if (!shared(field)) return own.value(field, raw, path, stage, wrong);
    switch (field.type) {
      case "integer":
      case "number": {
        const number = typeof raw === "string" && decimal.test(raw.trim()) ? Number(raw) : raw;
        return typeof number === "number" &&
          Number.isFinite(number) &&
          (field.type === "number" || Number.isSafeInteger(number)) &&
          number >= field.min &&
          number <= field.max
          ? number
          : wrong();
      }
      case "boolean":
        return typeof raw === "boolean"
          ? raw
          : raw === "true"
            ? true
            : raw === "false"
              ? false
              : wrong();
      case "string": {
        if (typeof raw !== "string" || raw.length === 0 || raw.length > field.max || !xmlSafe(raw))
          return wrong();
        // Models vary the case of an option; the canonical spelling is kept.
        const option = field.options
          ? field.options.find((each) => each.toLowerCase() === raw.toLowerCase())
          : raw;
        if (option === undefined) return wrong();
        if (field.pattern && !new RegExp(field.pattern).test(option)) return wrong();
        return option;
      }
      case "list":
        if (!Array.isArray(raw) || raw.length < field.min || raw.length > field.max) return wrong();
        return raw.map((item, index) => value(field.of, item, `${path}[${index}]`, stage));
      case "object":
        return object(field, raw, path, stage);
    }
  }

  function object(
    shape: Shape<C>,
    raw: unknown,
    path: string,
    stage: S,
    ignore: readonly string[] = [],
  ) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw))
      return fail(path, `expected an object; received ${received(raw)}`);
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(raw)) {
      // Absent and null mean the same thing; models send both.
      if (ignore.includes(key) || item === undefined || item === null) continue;
      const field = shape.fields[key];
      if (!field)
        return fail(
          path,
          `unknown field "${key.slice(0, 40)}"; allowed: ${Object.keys(shape.fields).join(", ")}`,
        );
      output[key] = value(field, item, `${path}.${key}`, stage);
    }
    for (const key of shape.required)
      if (!(key in output)) fail(path, `missing ${key} (${describe(shape.fields[key]!)})`);
    for (const group of shape.exclusive ?? [])
      if (group.filter((key) => key in output).length !== 1)
        fail(path, `provide exactly one of ${group.join(", ")}`);
    return output;
  }

  /**
   * Validates a batch before any worker opens the file. `check` sees each
   * operation after its fields passed, for rules that span fields or the batch.
   */
  function parse(
    input: unknown,
    stage: S,
    check?: (kind: string, operation: Record<string, unknown>, path: string) => void,
  ) {
    const list =
      typeof input === "string" && input.trim().startsWith("[") ? safeJson(input) : input;
    if (!Array.isArray(list) || list.length > config.maxOperations)
      return fail(
        "operations",
        `expected a list of at most ${config.maxOperations} operations; received ${Array.isArray(list) ? `${list.length} operations. Split into smaller calls; no edits were applied` : received(list)}`,
      );
    return list.map((raw, index) => {
      const kind = (raw as { kind?: unknown } | null)?.kind;
      if (typeof kind !== "string" || !Object.hasOwn(table, kind))
        return fail(
          `operations[${index}]`,
          `unknown kind; use one of ${Object.keys(table).join(", ")}`,
        );
      const path = `operations[${index}] ${kind}`;
      const operation = object(table[kind]!, raw, path, stage, ["kind"]);
      check?.(kind, operation, path);
      return { kind, ...operation };
    });
  }

  function schemaOf(field: Field<C>): JsonSchema {
    if (!shared(field)) return own.schema(field);
    switch (field.type) {
      case "integer":
      case "number":
        return {
          type: field.type,
          minimum: field.min,
          maximum: field.max,
          description: field.about,
        };
      case "boolean":
        return { type: "boolean", description: field.about };
      case "string":
        return field.options
          ? { type: "string", enum: field.options, description: field.about }
          : {
              type: "string",
              maxLength: field.max,
              ...(field.pattern ? { pattern: field.pattern } : {}),
              description: field.about,
            };
      case "list":
        return {
          type: "array",
          items: schemaOf(field.of),
          minItems: field.min,
          maxItems: field.max,
          description: field.about,
        };
      case "object":
        return objectSchema(field, field.about);
    }
  }
  function objectSchema(
    shape: Shape<C>,
    description: string,
    extra: JsonSchema = {},
    required: readonly string[] = shape.required,
  ): JsonSchema {
    return {
      type: "object",
      description,
      properties: {
        ...extra,
        ...Object.fromEntries(
          Object.entries(shape.fields).map(([key, field]) => [key, schemaOf(field)]),
        ),
      },
      required,
      additionalProperties: false,
    };
  }

  /** The operations parameter as the model sees it: one branch per kind. */
  const jsonSchema: JsonSchema = {
    type: "array",
    maxItems: config.maxOperations,
    description:
      config.description ?? "Ordered edits applied atomically; each item's kind picks its fields.",
    items: {
      anyOf: Object.entries(table).map(([kind, definition]) =>
        objectSchema(definition, definition.about, { kind: { type: "string", enum: [kind] } }, [
          "kind",
          ...definition.required,
        ]),
      ),
    },
  };

  /** "Added a slide and a chart and wrote the text", from operation kinds alone, for people. */
  function describeChanges(operations: readonly { readonly kind: string }[]) {
    const verbs = new Map<string, Map<string, number>>();
    for (const operation of operations) {
      const [verb, noun = ""] = table[operation.kind]!.change;
      const nouns = verbs.get(verb) ?? new Map<string, number>();
      nouns.set(noun, (nouns.get(noun) ?? 0) + 1);
      verbs.set(verb, nouns);
    }
    const sentence = listed(
      [...verbs].map(([verb, nouns]) => {
        const items = [...nouns]
          .filter(([noun]) => noun)
          .map(([noun, count]) => (count === 1 ? article(noun) : `${count} ${plural(noun)}`));
        return items.length ? `${verb} ${listed(items)}` : verb;
      }),
    );
    return sentence ? sentence[0]!.toUpperCase() + sentence.slice(1) : "";
  }

  return { fail, describe, value, parse, jsonSchema, describeChanges };
}
