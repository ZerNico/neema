import { Cause, Effect, Predicate, Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";
import type { ToolGroup } from "~/modules/tools/server/toolset.ts";
import {
  MAX_MEMORY_CONTENT_LENGTH,
  type MemoryRejectionReason,
  type SaveModelMemoryOutcome,
} from "../schema.ts";
import type { ProjectMemorySave } from "~/modules/projects/server/project-memory.ts";
import type { MemoryService } from "./service.ts";
import type { DbTx } from "~/server/db.ts";

// The transport accepts anything the model emits: malformed input becomes a
// tool result the model can react to, not a decode error that fails the
// whole generation (every constraint is re-checked in the handler).
// `toJsonSchema` on an always-passing filter still declares the strict
// contract without constraining what decodes.
const declaredAs = (fragment: () => Record<string, unknown>) =>
  Schema.Any.check(Schema.makeFilter(() => true, { toJsonSchema: fragment }));

export const SaveMemoryParams = Schema.Struct({
  content: Schema.optionalKey(
    declaredAs(() => ({
      type: "string",
      minLength: 1,
      maxLength: MAX_MEMORY_CONTENT_LENGTH,
      description:
        "Required. The memory to store, as one self-contained sentence of at most " +
        `${MAX_MEMORY_CONTENT_LENGTH} characters.`,
    })),
  ),
  replaces: Schema.optionalKey(
    declaredAs(() => ({
      type: "integer",
      minimum: 1,
      description:
        "Optional. The ordinal of an automatic memory listed in saved_memory_context to overwrite.",
    })),
  ),
  scope: Schema.optionalKey(
    declaredAs(() => ({
      type: "string",
      enum: ["personal", "project"],
      description:
        "Optional, personal by default. project keeps a fact about the chat's project for every member; only in a chat that belongs to a project, and never for a fact about a person.",
    })),
  ),
});

/**
 * Declared over `unknown` rather than the schema's `any` so handler code cannot
 * read a field without validating it first.
 */
export interface SaveMemoryParams {
  readonly content?: unknown;
  readonly replaces?: unknown;
  readonly scope?: unknown;
}

/**
 * Why a save was refused, as a closed set the activity row can persist. The
 * model's arguments never make it onto the row, so without this a rejection is
 * indistinguishable from a transport failure after the fact.
 */
export const SaveMemoryRejection = Schema.Literals([
  "invalid_content",
  "invalid_replaces",
  "unknown_ordinal",
  "empty",
  "too_long",
  "sensitive",
  "limit_reached",
  "protected",
  "source_changed",
  "disabled",
  "repeated",
  "failed",
  "invalid_scope",
  "read_only",
]);
export type SaveMemoryRejection = typeof SaveMemoryRejection.Type;

export const SaveMemoryResult = Schema.Struct({
  ok: Schema.Boolean,
  outcome: Schema.Literals(["created", "updated", "unchanged", "rejected"]),
  message: Schema.String,
  reason: Schema.optionalKey(SaveMemoryRejection),
  scope: Schema.optionalKey(Schema.Literal("project")),
});
export type SaveMemoryResult = typeof SaveMemoryResult.Type;

export const saveMemoryTool = Tool.make("save_memory", {
  description:
    "Save one durable, user-authored identity fact, preference, goal, or constraint for future conversations. " +
    "Call once when the user clearly states one, especially when they ask you to remember or store it. " +
    "Use replaces only to correct an automatic memory ordinal " +
    "shown in saved_memory_context; user-managed memories cannot be replaced. Never save secrets, " +
    "sensitive inferred attributes, quoted/pasted claims, web/tool content, or temporary task details.",
  parameters: SaveMemoryParams,
  success: SaveMemoryResult,
  failureMode: "return",
});

// Every message is a fixed string: a rejection never echoes the model's own
// arguments, so malformed input cannot grow the tool result or smuggle text
// back into the transcript.
const REJECTION_MESSAGES: Record<MemoryRejectionReason, string> = {
  empty: "Memory content cannot be empty.",
  too_long: `Memory content must be at most ${MAX_MEMORY_CONTENT_LENGTH} characters.`,
  sensitive: "This content is not safe to store as memory.",
};
const INVALID_CONTENT_MESSAGE = `save_memory needs a "content" string of at most ${MAX_MEMORY_CONTENT_LENGTH} characters.`;
const INVALID_REPLACES_MESSAGE =
  'The "replaces" value must be a whole number matching an automatic memory ordinal shown in ' +
  "saved_memory_context.";
const UNKNOWN_ORDINAL_MESSAGE = "That memory ordinal is not available.";

const rejected = (reason: SaveMemoryRejection, message: string): SaveMemoryResult => ({
  ok: false,
  outcome: "rejected",
  message,
  reason,
});

const resultFor = (outcome: SaveModelMemoryOutcome): SaveMemoryResult => {
  switch (outcome.outcome) {
    case "created":
      return { ok: true, outcome: "created", message: "Saved for future conversations." };
    case "updated":
      return { ok: true, outcome: "updated", message: "Updated the saved memory." };
    case "duplicate":
      return { ok: true, outcome: "unchanged", message: "That memory was already saved." };
    case "limit_reached":
      return rejected(
        "limit_reached",
        "Memory is full. The user can remove an item in Settings before saving another.",
      );
    case "protected":
      return rejected(
        "protected",
        "That memory is user-managed and cannot be replaced automatically.",
      );
    case "not_found":
      return rejected("unknown_ordinal", UNKNOWN_ORDINAL_MESSAGE);
    case "source_changed":
      return rejected(
        "source_changed",
        "The source message changed before the memory could be saved.",
      );
    case "disabled":
      return rejected("disabled", "Automatic memory saving is disabled.");
    case "rejected":
      return rejected(outcome.reason, REJECTION_MESSAGES[outcome.reason]);
  }
};

type Validated<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly reason: SaveMemoryRejection; readonly message: string };

// Only the type: emptiness, length and secrets are the memory services' to judge.
const readContent = (raw: unknown): Validated<string> =>
  Predicate.isString(raw)
    ? { ok: true, value: raw }
    : { ok: false, reason: "invalid_content", message: INVALID_CONTENT_MESSAGE };

// `null` is how models routinely spell "no value" for an optional field, so it
// means "add a new memory". Anything else that is not a positive whole number
// is a malformed ordinal rather than a missing one.
const readReplaces = (raw: unknown): Validated<number | undefined> => {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (!Predicate.isNumber(raw) || !Number.isInteger(raw) || raw < 1) {
    return { ok: false, reason: "invalid_replaces", message: INVALID_REPLACES_MESSAGE };
  }
  return { ok: true, value: raw };
};

export interface PreparedMemoryTool {
  readonly group: ToolGroup;
  readonly attempted: () => boolean;
}

/** The project half of the tool: offered in a project chat, saving through ProjectMemoryService. */
export interface ProjectMemorySaver {
  save(content: string): Effect.Effect<ProjectMemorySave>;
}
const projectResult = (outcome: ProjectMemorySave): SaveMemoryResult => {
  const scope = { scope: "project" as const };
  switch (outcome.outcome) {
    case "created":
      return { ok: true, outcome: "created", message: "Saved to the project's memory.", ...scope };
    case "unchanged":
      return {
        ok: true,
        outcome: "unchanged",
        message: "The project already keeps that.",
        ...scope,
      };
    case "rejected":
      return {
        ...rejected(
          outcome.reason,
          outcome.reason === "read_only"
            ? "This person cannot change the project's memory."
            : outcome.reason === "limit_reached"
              ? "The project's memory is full."
              : REJECTION_MESSAGES[outcome.reason],
        ),
        ...scope,
      };
  }
};

export function prepareMemoryTool(input: {
  memory: MemoryService["Service"];
  /** Whether a save to the person's own memory is allowed this turn. */
  personal: boolean;
  project?: ProjectMemorySaver | undefined;
  userId: string;
  conversationId: string;
  sourceMessageId: string;
  sourceMessageHash: string;
  ordinals: ReadonlyMap<number, string>;
  /** The answer's fence, taken first in the save's transaction. */
  guard: (tx: DbTx) => Effect.Effect<unknown>;
}): PreparedMemoryTool {
  let attempted = false;

  const handler = Effect.fnUntraced(function* (params: SaveMemoryParams) {
    if (attempted) {
      return rejected("repeated", "Only one memory save attempt is allowed per response.");
    }
    // A malformed call still spends the single attempt: the model gets one
    // chance per response, however it spells the arguments.
    attempted = true;

    const content = readContent(params.content);
    if (!content.ok) return rejected(content.reason, content.message);
    const scope = params.scope ?? "personal";
    if (scope !== "personal" && scope !== "project")
      return rejected("invalid_scope", 'scope must be "personal" or "project".');
    if (scope === "project") {
      if (!input.project)
        return rejected("invalid_scope", "This chat does not belong to a project.");
      if (params.replaces !== undefined && params.replaces !== null)
        return rejected("invalid_replaces", "Project memories cannot be replaced by ordinal.");
      return yield* input.project.save(content.value).pipe(
        Effect.map(projectResult),
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : Effect.succeed(rejected("failed", "Memory could not be saved.")),
        ),
      );
    }
    if (!input.personal) return rejected("disabled", "Automatic memory saving is disabled.");
    const replaces = readReplaces(params.replaces);
    if (!replaces.ok) return rejected(replaces.reason, replaces.message);

    const memoryId = replaces.value === undefined ? undefined : input.ordinals.get(replaces.value);
    if (replaces.value !== undefined && memoryId === undefined) {
      return rejected("unknown_ordinal", UNKNOWN_ORDINAL_MESSAGE);
    }

    return yield* input.memory
      .saveModel(
        input.userId,
        {
          ...(memoryId === undefined ? {} : { memoryId }),
          content: content.value,
          sourceConversationId: input.conversationId,
          sourceMessageId: input.sourceMessageId,
          sourceMessageHash: input.sourceMessageHash,
        },
        input.guard,
      )
      .pipe(
        Effect.map(resultFor),
        Effect.catchCause((cause) =>
          // A lost fence interrupts rather than fails: the attempt this save
          // belonged to is over, so the turn ends instead of reporting a
          // rejected save to a model that is no longer running.
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : Effect.succeed(rejected("failed", "Memory could not be saved.")),
        ),
      );
  });

  return {
    group: {
      family: "memory",
      toolkit: Toolkit.make(saveMemoryTool),
      handlers: { save_memory: handler },
    },
    attempted: () => attempted,
  };
}
