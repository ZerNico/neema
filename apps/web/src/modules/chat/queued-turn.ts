/**
 * The submission a queued message replays when it finally starts. Frozen when
 * the person queued it, so editing the composer afterwards cannot rewrite work
 * they already handed over. Live access (agent, collections, skills) is still
 * resolved at promotion, exactly as an ordinary send resolves it.
 *
 * Nothing about the desktop is stored. An executor id names one running app
 * and a folder list names what that app had attached; both can be stale by the
 * time the entry reaches the front, so a Work entry takes them fresh from the
 * desktop app that dispatches it. Files live in their own ownership table.
 */
export interface QueuedTurnInput {
  modelId: string;
  searchEnabled: boolean;
  researchEnabled: boolean;
  skillIds?: ReadonlyArray<string> | undefined;
  collectionIds?: ReadonlyArray<string> | undefined;
  timeZone?: string | undefined;
  openDocumentId?: string | undefined;
}
