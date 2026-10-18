import { Effect, Schema } from "effect";
import { MAX_MEMORY_CONTENT_LENGTH, type MemoryWriteOutcome } from "~/modules/memory/schema.ts";
import { MemoryService } from "~/modules/memory/server/service.ts";
import { defineTool, refused, result } from "./define.ts";

const changes = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

/**
 * Memory as this person has it: on for the instance and allowed for them.
 * The app's manual writes check the person but not the instance's switch,
 * resting on the settings page being shown only when it is on.
 */
const unavailable = () => refused("Memory isn't available to this account.");
const memoryOn = Effect.fn("mcp.memoryOn")(function* (userId: string) {
  const settings = yield* MemoryService.use((memory) => memory.getSettings(userId));
  if (!settings.globalEnabled) return yield* unavailable();
});

const REJECTIONS = {
  empty: "A memory can't be empty.",
  too_long: `A memory is at most ${MAX_MEMORY_CONTENT_LENGTH} characters.`,
  sensitive: "That looks like a password, card or account number, which memory never keeps.",
} as const;

const explainWrite = (outcome: MemoryWriteOutcome) => {
  switch (outcome.outcome) {
    case "created":
    case "updated":
      return { ok: true as const, text: "Saved.", id: outcome.memory.id };
    case "duplicate":
      return { ok: true as const, text: "That was already saved.", id: outcome.memory.id };
    case "rejected":
      return {
        ok: false as const,
        text: REJECTIONS[outcome.reason],
      };
    case "limit_reached":
      return { ok: false as const, text: "Memory is full. Delete one first." };
    case "not_found":
      return { ok: false as const, text: "There is no memory with that id. Call list_memories." };
    default:
      return { ok: false as const, text: "That can't be saved." };
  }
};

export const listMemories = defineTool({
  name: "list_memories",
  title: "List memories",
  description:
    "What this person asked the app to remember about them, newest first. Each has an id for update_memory and delete_memory.",
  scope: "memory:read",
  input: Schema.Struct({}),
  annotations: { readOnlyHint: true, openWorldHint: false },
  run: (_args, { principal }) =>
    Effect.gen(function* () {
      yield* memoryOn(principal.userId);
      const memories = (yield* MemoryService.use((memory) => memory.list(principal.userId))).map(
        (memory) => ({ id: memory.id, content: memory.content, createdAt: memory.createdAt }),
      );
      return result(
        memories.length
          ? memories.map((m) => `- ${m.content} (${m.id})`).join("\n")
          : "Nothing is remembered.",
        { memories },
      );
    }),
});

export const saveMemory = defineTool({
  name: "save_memory",
  title: "Save a memory",
  description: `Saves one short fact about this person (at most ${MAX_MEMORY_CONTENT_LENGTH} characters) for the app to remember in their chats. Never passwords or account numbers.`,
  scope: "memory:write",
  input: Schema.Struct({ content: Schema.String }),
  annotations: changes,
  run: (args, { principal }) =>
    Effect.gen(function* () {
      yield* memoryOn(principal.userId);
      const outcome = explainWrite(
        yield* MemoryService.use((memory) =>
          memory.createManual(principal.userId, args.content),
        ).pipe(
          // Taken away between the check above and the write.
          Effect.catchTag("CapabilityDenied", unavailable),
        ),
      );
      if (!outcome.ok) return yield* refused(outcome.text);
      return result(outcome.text, { id: outcome.id });
    }),
});

export const updateMemory = defineTool({
  name: "update_memory",
  title: "Change a memory",
  description: "Rewrites one memory, by its id from list_memories.",
  scope: "memory:write",
  input: Schema.Struct({ memoryId: Schema.String, content: Schema.String }),
  annotations: { ...changes, idempotentHint: true },
  run: (args, { principal }) =>
    Effect.gen(function* () {
      yield* memoryOn(principal.userId);
      const outcome = explainWrite(
        yield* MemoryService.use((memory) =>
          memory.updateManual(principal.userId, { memoryId: args.memoryId, content: args.content }),
        ).pipe(Effect.catchTag("CapabilityDenied", unavailable)),
      );
      if (!outcome.ok) return yield* refused(outcome.text);
      return result(outcome.text, { id: outcome.id });
    }),
});

export const deleteMemory = defineTool({
  name: "delete_memory",
  title: "Forget a memory",
  description: "Deletes one memory, by its id from list_memories.",
  scope: "memory:write",
  input: Schema.Struct({ memoryId: Schema.String }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  run: (args, { principal }) =>
    Effect.gen(function* () {
      yield* memoryOn(principal.userId);
      const outcome = yield* MemoryService.use((memory) =>
        memory.delete(principal.userId, args.memoryId),
      ).pipe(Effect.catchTag("CapabilityDenied", unavailable));
      if (outcome.outcome === "not_found")
        return yield* refused("There is no memory with that id. Call list_memories.");
      return result("Forgotten.", { deleted: true });
    }),
});
