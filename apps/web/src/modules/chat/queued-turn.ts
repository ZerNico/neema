import type { OpenDocument } from "./schema.ts";
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
import type { ReasoningEffort } from "~/modules/providers/model-config.ts";

export interface QueuedTurnInput {
  modelId: string;
  /** The composer's image model when queued; absent keeps the chat's own. */
  imageModelId?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  searchEnabled: boolean;
  researchEnabled: boolean;
  skillIds?: ReadonlyArray<string> | undefined;
  collectionIds?: ReadonlyArray<string> | undefined;
  timeZone?: string | undefined;
  openDocument?: OpenDocument | undefined;
}
