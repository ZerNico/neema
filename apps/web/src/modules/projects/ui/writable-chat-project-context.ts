import { createContext, use } from "react";

/** The project of the chat on screen, when the reader may change its files. */
export const WritableChatProject = createContext<{ id: string; name: string } | null>(null);

export const useWritableChatProject = () => use(WritableChatProject);
