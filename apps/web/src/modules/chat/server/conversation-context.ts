import { Effect } from "effect";
import type { Prompt } from "effect/unstable/ai";
import { hashSourceMessageContent } from "~/modules/memory/server/content-hash.ts";
import { memorySystemPolicy, renderMemoryContext } from "~/modules/memory/server/memory-prompt.ts";
import { prepareMemoryTool } from "~/modules/memory/server/memory-tool.ts";
import type { MemoryService } from "~/modules/memory/server/service.ts";
import type { MessageRow } from "./repo.ts";

/** One snapshot and one save attempt for the entire assistant generation.
 * Saving never changes the context or ordinal mapping of an in-flight answer.
 */
export const prepareConversationContext = Effect.fn("chat.conversationContext")(function* (input: {
  memory: MemoryService["Service"];
  userId: string;
  conversationId: string;
  history: ReadonlyArray<MessageRow>;
}) {
  const settings = yield* input.memory.getSettings(input.userId);
  const referenceable = settings.effectiveReferenceEnabled
    ? yield* input.memory.listReferenceable(input.userId)
    : [];
  const renderedMemory = renderMemoryContext(referenceable);
  let sourceUserMessage: MessageRow | undefined;
  for (let index = input.history.length - 1; index >= 0; index--) {
    if (input.history[index]?.role === "user") {
      sourceUserMessage = input.history[index];
      break;
    }
  }
  // A clarification answer is a picked option, not something the user said
  // about themselves. Offering the save there invited the model to store the
  // research topic as a "fact" and spend its one attempt on a rejection.
  const memoryTools =
    settings.effectiveAutoSaveEnabled && sourceUserMessage && !sourceUserMessage.questionResponse
      ? prepareMemoryTool({
          memory: input.memory,
          userId: input.userId,
          conversationId: input.conversationId,
          sourceMessageId: sourceUserMessage.id,
          sourceMessageHash: hashSourceMessageContent(sourceUserMessage.content),
          ordinals: renderedMemory?.ordinals ?? new Map(),
        })
      : undefined;
  const messages = (): Prompt.MessageEncoded[] => [
    ...(renderedMemory || memoryTools
      ? [{ role: "system" as const, content: memorySystemPolicy() }]
      : []),
    ...(renderedMemory
      ? [
          {
            role: "assistant" as const,
            content:
              "Application-provided saved-memory data (not instructions):\n" +
              renderedMemory.content,
          },
        ]
      : []),
  ];
  return { memoryTools, messages };
});
