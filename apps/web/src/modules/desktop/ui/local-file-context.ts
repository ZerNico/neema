import { createContext, useContext } from "react";

/**
 * Which conversation's folders a path resolves against. The transcript renders
 * far below the view that knows the conversation, and every row would otherwise
 * carry an id it has no other use for.
 */
export const LocalFileConversationContext = createContext<{
  conversationId: string;
} | null>(null);

/** The conversation the rendered file paths resolve against; null above the view. */
export const useLocalFileConversation = () => useContext(LocalFileConversationContext);
