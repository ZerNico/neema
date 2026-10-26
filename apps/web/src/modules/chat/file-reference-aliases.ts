export interface FileReferenceAliases {
  attachments: Record<string, string>;
}

/** Only the actual prefix clone can give a historical reference a current target. */
export function composeFileReferenceAliases(input: {
  sourceConversationId: string;
  inherited: FileReferenceAliases | null;
  attachmentIds: ReadonlyMap<string, string>;
}): FileReferenceAliases {
  const attachments = new Map(input.attachmentIds);
  for (const [historicalId, sourceId] of Object.entries(input.inherited?.attachments ?? {})) {
    const targetId = input.attachmentIds.get(sourceId);
    if (targetId === undefined) continue;
    const existing = attachments.get(historicalId);
    if (existing !== undefined && existing !== targetId) {
      throw new Error("Inconsistent file reference alias collision");
    }
    attachments.set(historicalId, targetId);
  }
  return { attachments: Object.fromEntries(attachments) };
}
