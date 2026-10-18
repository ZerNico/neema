import { Effect, Schema } from "effect";
import { decodeToolInput } from "~/modules/tools/server/toolset.ts";
import type { ConversationDraft } from "../draft-schema.ts";

export const DraftId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
export const ReadDraftParams = Schema.Struct({ draftId: Schema.optionalKey(DraftId) });

// Names a model reaches for when it has read the field list once and then
// paraphrases it. The advertised schema is the source of truth; these only
// spare a correction round trip for the common near misses.
const DRAFT_ID_ALIASES: Record<string, string> = {
  draft: "draftId",
  draft_id: "draftId",
  id: "draftId",
};

type Invalid = { outcome: "invalid"; message: string };
type Unavailable = { outcome: "unavailable"; message: string };

/**
 * The per-attempt state and plumbing one draft kind's tools share: the chat's
 * drafts and the focused one, addressing by id, lenient input decoding, and
 * logging that keeps private settings out of tool rows. Each kind keeps its
 * own tools, aliases, validation and prompt data.
 */
export function makeDraftSession<
  D extends ConversationDraft<{ readonly name: string }>,
  Summary,
  State,
>(config: {
  /** Names the kind in logs, messages and the open tool ("agent", "schedule"). */
  noun: string;
  /** How messages name this chat's drafts ("drafts", "schedule drafts"). */
  plural: string;
  conversationId: string;
  list: () => Effect.Effect<D[]>;
  summary: (draft: D) => Summary;
  state: (draft: D) => State;
  /** Paraphrased setting names, applied inside `changes`. */
  fieldAliases: Record<string, string>;
  /** Settings where null is a real value (it clears the setting), so it is kept. */
  nullable: ReadonlySet<string>;
  /** Normalizes a kind's own top-level parameter value. */
  normalize?: (key: string, value: unknown) => unknown;
}) {
  // Models write "no value" as null and small integers as strings. Both mean the
  // key is absent or the number itself; refusing them only burns a round trip.
  const lenient = (raw: unknown, changes = false): unknown => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
    const out: Record<string, unknown> = {};
    for (const [rawKey, value] of Object.entries(raw)) {
      const key = (changes ? config.fieldAliases : DRAFT_ID_ALIASES)[rawKey] ?? rawKey;
      if (value === null || value === undefined) {
        if (config.nullable.has(key)) out[key] = null;
        continue;
      }
      if (key === "changes") out[key] = lenient(value, true);
      else if (key === "expectedRevision" && typeof value === "string" && /^\d+$/.test(value))
        out[key] = Number(value);
      else out[key] = config.normalize ? config.normalize(key, value) : value;
    }
    return out;
  };
  const rejected = (tool: string, issue: string) =>
    Effect.logWarning(`${config.noun} draft tool input rejected`, {
      conversationId: config.conversationId,
      tool,
      issue,
    });
  /** Decodes leniently; a rejection is logged and answered with `hint` plus the issue. */
  const decode = <S extends Schema.Codec<unknown, unknown, never, never>>(
    tool: string,
    schema: S,
    raw: unknown,
    hint: string,
  ): Effect.Effect<{ ok: true; value: S["Type"] } | { ok: false; result: Invalid }> => {
    const decoded = decodeToolInput(schema, lenient(raw));
    if (decoded.ok) return Effect.succeed(decoded);
    return rejected(tool, decoded.issue).pipe(
      Effect.as({
        ok: false as const,
        result: { outcome: "invalid" as const, message: `${hint} ${decoded.issue}` },
      }),
    );
  };

  // Every draft this chat owns, oldest first, plus the one a tool last touched.
  // The focused draft is the only one sent in full; the rest are summaries, so
  // several drafts with long settings cannot inflate every later request.
  let known: D[] = [];
  let focusedDraftId: string | null = null;
  const focused = () => known.find((draft) => draft.id === focusedDraftId) ?? null;
  const others = () => known.filter((draft) => draft.id !== focusedDraftId).map(config.summary);
  const unavailable: Unavailable = {
    outcome: "unavailable",
    message: `No ${config.noun} draft is available in this chat. Use draft_${config.noun} to prepare one.`,
  };
  const names = () =>
    known.map((draft) => `${draft.id} (${draft.settings.name || "untitled"})`).join(", ");
  /** One draft means no id is needed; several make an unaddressed call ambiguous. */
  const resolve = (draftId: string | undefined): D | Invalid | Unavailable => {
    if (draftId !== undefined)
      return (
        known.find((draft) => draft.id === draftId) ?? {
          outcome: "unavailable",
          message: `No draft ${draftId} in this chat. Current ${config.plural}: ${names() || "none"}.`,
        }
      );
    if (known.length === 1) return known[0]!;
    if (known.length === 0) return unavailable;
    return {
      outcome: "invalid",
      message: `This chat has several ${config.plural}, so draftId is required. Current drafts: ${names()}.`,
    };
  };
  /** Reloads the chat's drafts, keeping focus unless that draft is gone. */
  const sync = Effect.fn(function* () {
    known = yield* config.list();
    if (!known.some((draft) => draft.id === focusedDraftId))
      focusedDraftId = known.at(-1)?.id ?? null;
    return known;
  });
  /** Keeps the in-memory list in step with a write we just made. */
  const remember = (draft: D) => {
    const index = known.findIndex((row) => row.id === draft.id);
    known = index === -1 ? [...known, draft] : known.map((row, at) => (at === index ? draft : row));
    focusedDraftId = draft.id;
  };
  const reference = (draft: D) => ({
    draftId: draft.id,
    draftConversationId: draft.conversationId,
    revision: draft.revision,
    draft: config.state(draft),
  });
  const read = (raw: unknown, refresh: () => Effect.Effect<unknown>) =>
    Effect.gen(function* () {
      const decoded = yield* decode(
        `read_${config.noun}_draft`,
        ReadDraftParams,
        raw,
        "Pass an optional draftId.",
      );
      if (!decoded.ok) return decoded.result;
      yield* refresh();
      // No id with several drafts is a listing request, not an ambiguous one:
      // the model is asking what exists before choosing.
      if (decoded.value.draftId === undefined && known.length !== 1)
        return known.length === 0
          ? unavailable
          : { outcome: "read" as const, drafts: known.map(config.summary) };
      const draft = resolve(decoded.value.draftId);
      if (!("id" in draft)) return draft;
      focusedDraftId = draft.id;
      return { outcome: "read" as const, ...reference(draft) };
    });
  /** The tool result for a patch the service answered. */
  const patched = <C extends object>(
    result: { outcome: "updated" | "unchanged" | "conflict"; draft: D },
    changes: C,
  ) => {
    remember(result.draft);
    return {
      outcome: result.outcome,
      ...reference(result.draft),
      ...(result.outcome === "conflict"
        ? {
            message:
              "The draft changed while you were working. Read its current values and preserve the user's edits.",
          }
        : { changedFields: Object.keys(changes) as Array<keyof C & string> }),
    };
  };
  // Keep failures terminal (including failed research fences), but never copy
  // a driver defect containing private settings into a public tool error row.
  // The real cause still reaches the server log, or a schema drift is invisible.
  const bounded = <A>(effect: Effect.Effect<A>) =>
    effect.pipe(
      Effect.catchDefect((defect) =>
        Effect.logError(`${config.noun} draft tool failed`, {
          conversationId: config.conversationId,
          defect: defect instanceof Error ? `${defect.name}: ${defect.message}` : String(defect),
        }).pipe(
          Effect.andThen(Effect.die(new Error(`Could not prepare the ${config.noun} draft.`))),
        ),
      ),
    );
  return {
    known: () => known,
    focused,
    others,
    unavailable,
    resolve,
    sync,
    remember,
    reference,
    decode,
    read,
    patched,
    bounded,
  };
}
