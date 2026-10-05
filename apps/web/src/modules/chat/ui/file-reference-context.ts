import { createContext } from "react";
import type { Attachment } from "~/modules/attachments/schema.ts";
import type { FileReferenceAliases } from "../file-reference-aliases.ts";

export const FileReferenceContext = createContext<{
  attachments: ReadonlyMap<string, Attachment>;
  aliases: FileReferenceAliases | null;
  machineId: string | null;
}>({ attachments: new Map(), aliases: null, machineId: null });

export const FileReferenceMachine = createContext<string | null>(null);
