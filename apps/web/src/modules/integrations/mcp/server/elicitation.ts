import type { ElicitRequest, ElicitResult } from "@modelcontextprotocol/client";
import type {
  ElicitationAnswer,
  ElicitationField,
  ElicitationPrompt,
  ElicitationValue,
} from "../../schema.ts";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown, max: number) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

const optionsOf = (schema: Json): ElicitationField["options"] | null => {
  const values = Array.isArray(schema.enum) ? schema.enum : null;
  if (values?.every((value) => typeof value === "string")) {
    const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
    return values.map((value, index) => ({
      value: value as string,
      label: text(names[index], 120) || (value as string),
    }));
  }
  const choices = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : null;
  if (choices?.every((choice) => isObject(choice) && typeof choice.const === "string"))
    return (choices as Json[]).map((choice) => ({
      value: choice.const as string,
      label: text(choice.title, 120) || (choice.const as string),
    }));
  return null;
};

/** What a card can hold, and what an answer may carry back (`AnswerElicitationInput`). */
const MAX_FIELDS = 30;
const MAX_KEY = 100;

const fieldOf = (key: string, schema: unknown, required: boolean): ElicitationField | null => {
  if (!isObject(schema)) return null;
  const base = {
    key,
    label: text(schema.title, 120) || key,
    description: text(schema.description, 500) || null,
    required,
  };
  const options = optionsOf(schema);
  if (schema.type === "string" || options) {
    if (options) {
      const fallback = typeof schema.default === "string" ? { default: schema.default } : {};
      return { ...base, kind: "choice", options, ...fallback };
    }
    const kind =
      schema.format === "email"
        ? "email"
        : schema.format === "uri"
          ? "url"
          : schema.format === "date"
            ? "date"
            : schema.format === "date-time"
              ? "datetime"
              : "text";
    return {
      ...base,
      kind,
      ...(typeof schema.default === "string" ? { default: schema.default } : {}),
      ...(typeof schema.minLength === "number" ? { min: schema.minLength } : {}),
      ...(typeof schema.maxLength === "number" ? { max: schema.maxLength } : {}),
    };
  }
  if (schema.type === "number" || schema.type === "integer")
    return {
      ...base,
      kind: schema.type,
      ...(typeof schema.default === "number" ? { default: schema.default } : {}),
      ...(typeof schema.minimum === "number" ? { min: schema.minimum } : {}),
      ...(typeof schema.maximum === "number" ? { max: schema.maximum } : {}),
    };
  if (schema.type === "boolean")
    return {
      ...base,
      kind: "boolean",
      ...(typeof schema.default === "boolean" ? { default: schema.default } : {}),
    };
  if (schema.type === "array" && isObject(schema.items)) {
    const choices = optionsOf(schema.items);
    if (!choices) return null;
    return { ...base, kind: "choices", options: choices };
  }
  return null;
};

/**
 * What the person is shown, or null when it cannot be shown faithfully: a
 * form field of a kind the spec does not allow, or a page that is not https.
 * Either is declined rather than half-asked.
 */
export const promptOf = (params: ElicitRequest["params"]): ElicitationPrompt | null => {
  const message = text(params.message, 2_000);
  if (params.mode === "url") {
    const url = "url" in params && typeof params.url === "string" ? params.url : "";
    if (!URL.canParse(url) || new URL(url).protocol !== "https:") return null;
    return { mode: "url", message, url };
  }
  const schema = "requestedSchema" in params ? params.requestedSchema : null;
  if (!isObject(schema) || !isObject(schema.properties)) return null;
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((key) => typeof key === "string") : [],
  );
  // Cutting a form short, or a key, would send an answer to a question nobody asked.
  const entries = Object.entries(schema.properties);
  if (entries.length > MAX_FIELDS || entries.some(([key]) => key.length > MAX_KEY)) return null;
  const fields = entries.map(([key, property]) => fieldOf(key, property, required.has(key)));
  if (fields.some((field) => field === null)) return null;
  return { mode: "form", message, fields: fields as ElicitationField[] };
};

const fits = (field: ElicitationField, value: ElicitationValue) => {
  switch (field.kind) {
    case "boolean":
      return typeof value === "boolean";
    case "number":
    case "integer":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        (field.kind === "number" || Number.isInteger(value)) &&
        (field.min === undefined || value >= field.min) &&
        (field.max === undefined || value <= field.max)
      );
    case "choice":
      return typeof value === "string" && field.options!.some((option) => option.value === value);
    case "choices":
      return (
        Array.isArray(value) &&
        value.every((item) => field.options!.some((option) => option.value === item))
      );
    default:
      return (
        typeof value === "string" &&
        (field.min === undefined || value.length >= field.min) &&
        (field.max === undefined || value.length <= field.max)
      );
  }
};

/**
 * The answer as the server gets it. Values are checked against the form,
 * since the browser's controls are not a boundary; a form that does not
 * check out is declined, never sent half-filled.
 */
export const resultOf = (prompt: ElicitationPrompt, answer: ElicitationAnswer): ElicitResult => {
  if (answer.action !== "accept") return { action: answer.action };
  if (prompt.mode === "url") return { action: "accept" };
  const values = answer.values ?? {};
  const content: Record<string, string | number | boolean | string[]> = {};
  for (const field of prompt.fields) {
    const value = values[field.key];
    if (value === undefined || value === "") {
      if (field.required) return { action: "decline" };
      continue;
    }
    if (!fits(field, value)) return { action: "decline" };
    content[field.key] = typeof value === "object" ? [...value] : value;
  }
  return { action: "accept", content };
};
