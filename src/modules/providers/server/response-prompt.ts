import { Prompt, type Response } from "effect/unstable/ai";

/** One provider turn: retain file positions and final, opaque OpenRouter replay metadata. */
export const responseTurnPrompt = (parts: ReadonlyArray<Response.AnyPart>): Prompt.Prompt => {
  const assistant: Array<Prompt.AssistantMessagePart> = [];
  const tools: Array<Prompt.Message> = [];
  let options: Prompt.AssistantMessage["options"] = { openrouter: { imageReplay: true } };
  for (const part of parts) {
    if (
      part.type === "text" ||
      part.type === "text-delta" ||
      part.type === "reasoning" ||
      part.type === "reasoning-delta"
    ) {
      const type = part.type.startsWith("text") ? "text" : "reasoning";
      const text = "delta" in part ? part.delta : part.text;
      const previous = assistant.at(-1);
      if (previous?.type === type) {
        assistant[assistant.length - 1] = Prompt.makePart(type, { text: previous.text + text });
      } else assistant.push(Prompt.makePart(type, { text }));
    } else if (part.type === "file") {
      assistant.push(Prompt.makePart("file", { mediaType: part.mediaType, data: part.data }));
    } else if (part.type === "finish") {
      const details = part.metadata.openrouter?.reasoningDetails;
      if (Array.isArray(details))
        options = { openrouter: { imageReplay: true, reasoningDetails: details } };
    } else if (
      part.type === "tool-call" ||
      part.type === "tool-result" ||
      part.type === "tool-approval-request"
    ) {
      for (const message of Prompt.fromResponseParts([part]).content) {
        if (message.role === "assistant") assistant.push(...message.content);
        else tools.push(message);
      }
    }
  }
  return Prompt.make([
    ...(assistant.length > 0
      ? [Prompt.makeMessage("assistant", { content: assistant, options })]
      : []),
    ...tools,
  ]);
};
