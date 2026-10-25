import { Context, Effect, Layer } from "effect";
import type { DbTx } from "~/server/db.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { ToolsRepo } from "~/modules/tools/server/repo.ts";
import { CapabilityDenied } from "~/modules/groups/errors.ts";
import { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import {
  MAX_MEMORY_CONTENT_LENGTH,
  type CreateMemoryOutcome,
  type DeleteMemoryOutcome,
  type Memory,
  type MemoryPreferences,
  type MemoryRejectionReason,
  type MemorySettings,
  type SaveModelMemoryInput,
  type SaveModelMemoryOutcome,
  type UpdateMemoryOutcome,
  type UpdateMemorySettingsInput,
} from "../schema.ts";
import { hashMemoryContent } from "./content-hash.ts";
import { MemoryRepo } from "./repo.ts";

// Memory rows are replayed into every later prompt, so anything that looks like
// a live credential or high-risk personal identifier must never be stored. The
// bar is "obvious": each rule is a vendor-specific token shape or
// checksum-validated identifier, since a false positive drops a legitimate
// memory with no override.
const obviousSensitivePatterns = [
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/iu,
  /\b(?:sk|pk|rk)_(?:live|test)_[a-z0-9]{16,}\b/iu,
  /\bsk-[a-z0-9_-]{16,}\b/iu,
  /\b(?:ghp|gho|ghu|ghs|github_pat)_[a-z0-9_]{16,}\b/iu,
  /\bglpat-[a-z0-9_-]{20,}/iu,
  /\bxox[baprs]-[a-z0-9-]{16,}\b/iu,
  /\bhooks\.slack\.com\/services\/T[a-z0-9]+\/B[a-z0-9]+\/[a-z0-9]{16,}/iu,
  /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/u,
  // Google API key: literal AIza plus exactly 35 key characters.
  /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/u,
  /\bGOCSPX-[a-z0-9_-]{20,}/iu,
  /\bya29\.[a-z0-9_-]{20,}/iu,
  /\bSG\.[a-z0-9_-]{16,}\.[a-z0-9_-]{16,}/iu,
  /\bnpm_[a-z0-9]{36}\b/iu,
  // Twilio account/API SIDs are a fixed 2-letter prefix plus 32 hex characters.
  /\b(?:AC|SK)[0-9a-f]{32}\b/u,
  // Extended private keys (BIP-32): distinctive prefix plus a long base58 body.
  /\b[xyz]prv[1-9A-HJ-NP-Za-km-z]{60,}/u,
  /\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b/iu,
  /\bbearer\s+[a-z0-9._~+/-]{12,}=*\b/iu,
  /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|auth[_ -]?token|client[_ -]?secret|password|passwd)\s*(?:is|:|=)\s*["']?\S{6,}/iu,
  // Labelled financial/government identifiers. The label alone is harmless
  // ("I keep my SSN in a password manager"), so a value of at least five digits
  // must follow an explicit `is`/`:`/`=` for the rule to fire.
  /\b(?:ssn|social[ _-]?security(?:[ _-]?number)?|routing[ _-]?number|account[ _-]?number|card[ _-]?number|credit[ _-]?card(?:[ _-]?number)?|cvv|cvc|sort[ _-]?code|iban|tax[ _-]?id|ein|tin|national[ _-]?insurance(?:[ _-]?number)?|passport[ _-]?(?:number|no\.?)|driver'?s?[ _-]?licen[cs]e(?:[ _-]?number)?)\b[ _-]*(?:#|no\.?|number)?\s*(?:is|:|=)\s*["']?[0-9](?:[ .-]?[0-9]){4,}/iu,
  // US SSN in its canonical punctuated form, with the ranges the SSA never
  // issues excluded. A bare run of nine digits is deliberately not matched.
  /(?<!\d)(?!000|666|9\d\d)\d{3}([- ])(?!00)\d{2}\1(?!0000)\d{4}(?!\d)/u,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:]+:[^\s/@]+@/iu,
] as const;

// Maximal run of digits optionally grouped by single spaces or hyphens. Greedy
// on purpose: a longer run than a card can ever be is skipped rather than
// truncated into a lucky match.
const digitRunPattern = /\d(?:[ -]?\d){12,}/gu;

// Issuer ranges, each anchored to the lengths that issuer actually mints.
// Diners is held to 14 digits so 15-digit IMEIs (which are also Luhn-valid and
// often start 30x) do not read as cards.
const cardIssuerPatterns = [
  /^4\d{12}(?:\d{3}(?:\d{3})?)?$/u, // Visa (13/16/19)
  /^5[1-5]\d{14}$/u, // Mastercard
  /^2(?:2(?:2[1-9]|[3-9]\d)|[3-6]\d{2}|7(?:[01]\d|20))\d{12}$/u, // Mastercard 2-series
  /^3[47]\d{13}$/u, // American Express
  /^3(?:0[0-5]|[68]\d)\d{11}$/u, // Diners Club
  /^35(?:2[89]|[3-8]\d)\d{12,15}$/u, // JCB
  /^6(?:011|5\d{2}|4[4-9]\d|22[1-9])\d{12,15}$/u, // Discover
  /^62\d{14,17}$/u, // UnionPay
] as const;

const passesLuhn = (digits: string): boolean => {
  let sum = 0;
  let doubled = false;
  for (let index = digits.length - 1; index >= 0; index--) {
    let value = digits.charCodeAt(index) - 48;
    if (doubled) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    doubled = !doubled;
  }
  return sum % 10 === 0;
};

const containsPaymentCard = (content: string): boolean => {
  for (const match of content.matchAll(digitRunPattern)) {
    const digits = match[0].replaceAll(/[ -]/gu, "");
    if (digits.length < 13 || digits.length > 19) continue;
    if (!cardIssuerPatterns.some((pattern) => pattern.test(digits))) continue;
    if (passesLuhn(digits)) return true;
  }
  return false;
};

// Country code plus total IBAN length, per the ISO 13616 registry. An unlisted
// country code is not treated as an IBAN at all, which keeps the mod-97 check
// from ever being applied to arbitrary uppercase text.
const ibanLengths = new Map(
  (
    "AD24 AE23 AL28 AT20 AZ28 BA20 BE16 BG22 BH22 BR29 BY28 CH21 CR22 CY28 CZ24 " +
    "DE22 DK18 DO28 EE20 EG29 ES24 FI18 FO18 FR27 GB22 GE22 GI23 GL18 GR27 GT28 " +
    "HR21 HU28 IE22 IL23 IQ23 IS26 IT27 JO30 KW30 KZ20 LB28 LC32 LI21 LT20 LU20 " +
    "LV21 LY25 MC27 MD24 ME22 MK19 MR27 MT31 MU30 NL18 NO15 PK24 PL28 PS29 PT25 " +
    "QA29 RO24 RS22 SA24 SC31 SE24 SI19 SK24 SM27 ST25 SV28 TL23 TN24 TR26 UA29 " +
    "VA22 VG24 XK20"
  )
    .split(" ")
    .map((entry) => [entry.slice(0, 2), Number(entry.slice(2))] as const),
);

const ibanCandidatePattern = /\b[a-z]{2}\d{2}(?:[ ]?[a-z0-9]{4})+(?:[ ]?[a-z0-9]{1,3})?\b/giu;

const isIban = (candidate: string): boolean => {
  const expectedLength = ibanLengths.get(candidate.slice(0, 2));
  if (expectedLength === undefined || candidate.length !== expectedLength) return false;
  // ISO 13616 mod-97: rotate the first four characters to the back, map letters
  // to two-digit values, and require a remainder of 1.
  const rotated = candidate.slice(4) + candidate.slice(0, 4);
  let remainder = 0;
  for (let index = 0; index < rotated.length; index++) {
    const code = rotated.charCodeAt(index);
    const value = code >= 65 ? code - 55 : code - 48;
    remainder = (remainder * (value > 9 ? 100 : 10) + value) % 97;
  }
  return remainder === 1;
};

const containsIban = (content: string): boolean => {
  for (const match of content.matchAll(ibanCandidatePattern)) {
    if (isIban(match[0].replaceAll(" ", "").toUpperCase())) return true;
  }
  return false;
};

export const containsObviousSensitiveValue = (content: string): boolean =>
  obviousSensitivePatterns.some((pattern) => pattern.test(content)) ||
  containsPaymentCard(content) ||
  containsIban(content);

/** What any memory, a person's or a project's, is stored as, or why it is refused. */
export const prepareMemoryContent = (
  content: string,
  maxLength: number = MAX_MEMORY_CONTENT_LENGTH,
):
  | { ok: true; content: string; contentHash: string }
  | { ok: false; reason: MemoryRejectionReason } => {
  const trimmed = content.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty" };
  if (trimmed.length > maxLength) return { ok: false, reason: "too_long" };
  if (containsObviousSensitiveValue(trimmed)) return { ok: false, reason: "sensitive" };
  return { ok: true, content: trimmed, contentHash: hashMemoryContent(trimmed) };
};

const changed = (outcome: { outcome: string }): boolean =>
  outcome.outcome === "created" || outcome.outcome === "updated" || outcome.outcome === "deleted";

export class MemoryService extends Context.Service<
  MemoryService,
  {
    getSettings(userId: string): Effect.Effect<MemorySettings>;
    updateSettings(
      userId: string,
      input: UpdateMemorySettingsInput,
    ): Effect.Effect<MemorySettings, CapabilityDenied>;
    list(userId: string): Effect.Effect<ReadonlyArray<Memory>>;
    listReferenceable(userId: string): Effect.Effect<ReadonlyArray<Memory>>;
    createManual(
      userId: string,
      content: string,
    ): Effect.Effect<CreateMemoryOutcome, CapabilityDenied>;
    updateManual(
      userId: string,
      input: { memoryId: string; content: string },
    ): Effect.Effect<UpdateMemoryOutcome, CapabilityDenied>;
    delete(userId: string, memoryId: string): Effect.Effect<DeleteMemoryOutcome, CapabilityDenied>;
    clear(userId: string): Effect.Effect<number, CapabilityDenied>;
    /** The model's save; `guard` takes the answer's fence first inside the save's transaction. */
    saveModel(
      userId: string,
      input: SaveModelMemoryInput,
      guard: (tx: DbTx) => Effect.Effect<unknown>,
    ): Effect.Effect<SaveModelMemoryOutcome, CapabilityDenied>;
  }
>()("chat/memory/MemoryService") {
  static readonly layer = Layer.effect(
    MemoryService,
    Effect.gen(function* () {
      const policy = yield* FeaturePolicy;
      const repo = yield* MemoryRepo;
      const sync = yield* SyncBus;
      const tools = yield* ToolsRepo;

      const publishChanged = (userId: string) =>
        sync
          .publish(userId, { type: "memory.changed" })
          .pipe(
            Effect.catchCause(() =>
              Effect.logWarning("memory changed but sync publication failed", { userId }),
            ),
          );
      const requireMemory = Effect.fn("MemoryService.requireMemory")(function* (userId: string) {
        if (!(yield* policy.can(userId, "memory")))
          return yield* new CapabilityDenied({ capability: "memory" });
      });
      const withAvailability = Effect.fn("MemoryService.withAvailability")(function* (
        userId: string,
        preferences: MemoryPreferences,
      ) {
        const globalEnabled =
          (yield* tools.getTool("memory"))?.enabled === true &&
          (yield* policy.can(userId, "memory"));
        return {
          ...preferences,
          globalEnabled,
          effectiveReferenceEnabled: globalEnabled && preferences.referenceEnabled,
          effectiveAutoSaveEnabled: globalEnabled && preferences.autoSaveEnabled,
          effectivePastChatsEnabled: globalEnabled && preferences.pastChatsEnabled,
        } satisfies MemorySettings;
      });
      const getSettings = Effect.fn("MemoryService.getSettings")(function* (userId: string) {
        return yield* withAvailability(userId, yield* repo.getSettings(userId));
      });

      const updateSettings = Effect.fn("MemoryService.updateSettings")(function* (
        userId: string,
        input: UpdateMemorySettingsInput,
      ) {
        yield* requireMemory(userId);
        const result = yield* repo.updateSettings(userId, input);
        if (result.changed) yield* publishChanged(userId);
        return yield* withAvailability(userId, result.preferences);
      });

      const listReferenceable = Effect.fn("MemoryService.listReferenceable")(function* (
        userId: string,
      ) {
        const settings = yield* getSettings(userId);
        return settings.effectiveReferenceEnabled ? yield* repo.listReferenceable(userId) : [];
      });

      const createManual = Effect.fn("MemoryService.createManual")(function* (
        userId: string,
        content: string,
      ) {
        yield* requireMemory(userId);
        const prepared = prepareMemoryContent(content);
        if (!prepared.ok) {
          return { outcome: "rejected", reason: prepared.reason } as const;
        }
        const outcome = yield* repo.createManual(userId, prepared);
        if (changed(outcome)) yield* publishChanged(userId);
        return outcome;
      });

      const updateManual = Effect.fn("MemoryService.updateManual")(function* (
        userId: string,
        input: { memoryId: string; content: string },
      ) {
        yield* requireMemory(userId);
        const prepared = prepareMemoryContent(input.content);
        if (!prepared.ok) {
          return { outcome: "rejected", reason: prepared.reason } as const;
        }
        const outcome = yield* repo.updateManual(userId, {
          memoryId: input.memoryId,
          ...prepared,
        });
        if (changed(outcome)) yield* publishChanged(userId);
        return outcome;
      });

      const deleteMemory = Effect.fn("MemoryService.delete")(function* (
        userId: string,
        memoryId: string,
      ) {
        yield* requireMemory(userId);
        const outcome = yield* repo.delete(userId, memoryId);
        if (changed(outcome)) yield* publishChanged(userId);
        return outcome;
      });

      const clear = Effect.fn("MemoryService.clear")(function* (userId: string) {
        yield* requireMemory(userId);
        const deleted = yield* repo.clear(userId);
        if (deleted > 0) yield* publishChanged(userId);
        return deleted;
      });

      const saveModel = Effect.fn("MemoryService.saveModel")(function* (
        userId: string,
        input: SaveModelMemoryInput,
        guard: (tx: DbTx) => Effect.Effect<unknown>,
      ) {
        yield* requireMemory(userId);
        const prepared = prepareMemoryContent(input.content);
        if (!prepared.ok) {
          return { outcome: "rejected", reason: prepared.reason } as const;
        }
        const outcome = yield* repo.saveModel(userId, { ...input, ...prepared, guard });
        if (changed(outcome)) yield* publishChanged(userId);
        return outcome;
      });

      return MemoryService.of({
        getSettings,
        updateSettings,
        list: Effect.fn(function* (userId) {
          return (yield* policy.can(userId, "memory")) ? yield* repo.list(userId) : [];
        }),
        listReferenceable,
        createManual,
        updateManual,
        delete: deleteMemory,
        clear,
        saveModel,
      });
    }),
  );
}
