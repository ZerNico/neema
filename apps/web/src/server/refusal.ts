import { Effect } from "effect";
import { english, type Localized, localized, verbatim } from "~/i18n/localized.ts";
import { m } from "~/paraglide/messages.js";
import { getLocale, type Locale } from "~/paraglide/runtime.js";
import type { AgentChanged, AgentNotAvailable, AgentRejected } from "~/modules/agents/errors.ts";
import type {
  AttachmentBusy,
  AttachmentNotAvailable,
  AttachmentRejected,
  AttachmentUnsupported,
} from "~/modules/attachments/errors.ts";
import { UNAUTHENTICATED_BODY } from "~/modules/auth/identity.ts";
import { NOT_APPROVED_BODY } from "~/modules/auth/signup.ts";
import type { AccountIneligible } from "~/modules/auth/server/account-eligibility.ts";
import type {
  BranchNotAllowed,
  ConversationBusy,
  ConversationNotFound,
  EditNotAllowed,
  InvalidMessage,
  MessageNotFound,
  ModelNotFound,
  NoActiveGeneration,
  QuestionUnavailable,
  QueueEntryNotFound,
  QueueFull,
  ResumeNotAllowed,
  RetryNotAllowed,
  WorkDesktopRequired,
} from "~/modules/chat/errors.ts";
import type {
  CustomToolCompileFailed,
  CustomToolConflict,
  CustomToolNotFound,
  CustomToolSlugTaken,
} from "~/modules/custom-tools/errors.ts";
import type { DocumentNotAvailable, DocumentRejected } from "~/modules/documents/schema.ts";
import type { DraftNotAvailable, DraftRejected } from "~/modules/drafts/draft-schema.ts";
import type {
  CapabilitiesRejected,
  CapabilityDenied,
  GroupMemberNotFound,
  GroupNameTaken,
  GroupNotFound,
} from "~/modules/groups/errors.ts";
import type { IntegrationNotAvailable } from "~/modules/integrations/errors.ts";
import type { KnowledgeNotAvailable, KnowledgeRejected } from "~/modules/knowledge/errors.ts";
import type { LimitRejected, StorageFull, UsageLimitReached } from "~/modules/limits/errors.ts";
import type { MailFailed } from "~/modules/notifications/server/mail.ts";
import type { PushRejected } from "~/modules/notifications/server/push.ts";
import type { FontRejected } from "~/modules/presentations/server/fonts.ts";
import type {
  ProjectFileConflict,
  ProjectNotAvailable,
  ProjectRejected,
} from "~/modules/projects/errors.ts";
import type {
  InvalidDefaultModelOrder,
  InvalidUtilityModel,
  UnhostedImageFamily,
} from "~/modules/providers/default-models.ts";
import type {
  ScheduleChanged,
  ScheduleNotAvailable,
  ScheduleRejected,
} from "~/modules/schedules/schema.ts";
import type {
  SharedResourceNotAvailable,
  SharingNotAllowed,
  SharingRateLimited,
} from "~/modules/sharing/errors.ts";
import type { SkillConflict, SkillNotAvailable, SkillRejected } from "~/modules/skills/errors.ts";
import type { InvalidSearchProvider } from "~/modules/tools/server/search-provider-repo.ts";
import type { ToolUnavailable } from "~/modules/tools/server/web-search.ts";

/**
 * How a server function answers a failure it expected: a status and a body the
 * page may show, rendered in the request's locale at the boundary.
 */
export interface Refusal {
  readonly status: number;
  readonly body: Localized;
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * The one 404 body. `readServerError` treats it as saying nothing, so the page
 * words the miss in its own context. Missing and forbidden read alike, so ids
 * cannot be probed.
 */
export const NOT_FOUND = "Not found";

/** Every failure a server function may let reach the boundary. */
export type Refusable =
  | AccountIneligible
  | AgentNotAvailable
  | AgentRejected
  | AgentChanged
  | AttachmentNotAvailable
  | AttachmentRejected
  | AttachmentUnsupported
  | BranchNotAllowed
  | CapabilitiesRejected
  | CapabilityDenied
  | ConversationBusy
  | ConversationNotFound
  | CustomToolCompileFailed
  | CustomToolConflict
  | CustomToolNotFound
  | CustomToolSlugTaken
  | DocumentNotAvailable
  | DocumentRejected
  | DraftNotAvailable
  | DraftRejected
  | EditNotAllowed
  | FontRejected
  | GroupMemberNotFound
  | GroupNameTaken
  | GroupNotFound
  | IntegrationNotAvailable
  | InvalidDefaultModelOrder
  | InvalidMessage
  | InvalidSearchProvider
  | InvalidUtilityModel
  | KnowledgeNotAvailable
  | KnowledgeRejected
  | MailFailed
  | MessageNotFound
  | ModelNotFound
  | NoActiveGeneration
  | ProjectNotAvailable
  | ProjectRejected
  | ProjectFileConflict
  | PushRejected
  | QuestionUnavailable
  | QueueEntryNotFound
  | QueueFull
  | ResumeNotAllowed
  | RetryNotAllowed
  | ScheduleChanged
  | ScheduleNotAvailable
  | ScheduleRejected
  | SharingNotAllowed
  | SharedResourceNotAvailable
  | SharingRateLimited
  | SkillConflict
  | SkillNotAvailable
  | SkillRejected
  | ToolUnavailable
  | UnhostedImageFamily
  | WorkDesktopRequired
  | AttachmentBusy
  | UsageLimitReached
  | LimitRejected
  | StorageFull;

export type RefusalTable = {
  readonly [Tag in Refusable["_tag"]]: (error: Extract<Refusable, { _tag: Tag }>) => Refusal;
};

/** Another wording for a tag where one caller's page needs it; the status is the caller's too. */
export type RefusalOverrides = Partial<RefusalTable>;

const notFound = (): Refusal => ({ status: 404, body: verbatim(NOT_FOUND) });
const because =
  (status: number) =>
  (error: { readonly reason: Localized | string }): Refusal => ({
    status,
    body: words(error.reason),
  });
// MIGRATION: modules still pass English strings; removed once every module is translated.
const words = (body: Localized | string) => (typeof body === "string" ? verbatim(body) : body);

const refusals: RefusalTable = {
  AccountIneligible: (error) =>
    error.reason === "unapproved"
      ? { status: 403, body: verbatim(NOT_APPROVED_BODY) }
      : { status: 401, body: verbatim(UNAUTHENTICATED_BODY) },
  AgentNotAvailable: notFound,
  AgentRejected: because(400),
  AgentChanged: because(409),
  AttachmentNotAvailable: notFound,
  AttachmentBusy: () => ({ status: 409, body: localized(m.chat_error_attachment_busy) }),
  AttachmentRejected: (error) => ({
    status: error.cause === "size" ? 413 : 415,
    body: words(error.reason),
  }),
  AttachmentUnsupported: (error) => ({
    status: 400,
    body: (locale) => `${error.fileName}: ${words(error.reason)(locale)}`,
  }),
  BranchNotAllowed: because(409),
  CapabilitiesRejected: because(400),
  CapabilityDenied: () => ({ status: 403, body: verbatim("Forbidden") }),
  ConversationBusy: () => ({ status: 409, body: localized(m.chat_error_conversation_busy) }),
  ConversationNotFound: notFound,
  // The compiler's own diagnostics, in the language the code is written in.
  CustomToolCompileFailed: (error) => ({ status: 400, body: verbatim(error.message) }),
  CustomToolConflict: () => ({ status: 409, body: localized(m.custom_tools_error_conflict) }),
  CustomToolNotFound: notFound,
  CustomToolSlugTaken: (error) => ({
    status: 409,
    body: localized(m.custom_tools_error_slug_taken, { slug: error.slug }),
  }),
  DocumentNotAvailable: notFound,
  DocumentRejected: because(400),
  DraftNotAvailable: notFound,
  DraftRejected: because(400),
  EditNotAllowed: because(409),
  FontRejected: because(400),
  GroupMemberNotFound: notFound,
  GroupNameTaken: () => ({ status: 409, body: localized(m.groups_error_name_taken) }),
  GroupNotFound: notFound,
  IntegrationNotAvailable: notFound,
  InvalidDefaultModelOrder: because(400),
  InvalidMessage: because(400),
  InvalidSearchProvider: because(400),
  InvalidUtilityModel: because(400),
  KnowledgeNotAvailable: notFound,
  KnowledgeRejected: because(400),
  LimitRejected: because(400),
  MailFailed: because(400),
  MessageNotFound: notFound,
  ModelNotFound: () => ({ status: 400, body: localized(m.chat_error_model_not_found) }),
  NoActiveGeneration: () => ({
    status: 409,
    body: localized(m.chat_error_no_active_generation),
  }),
  ProjectNotAvailable: notFound,
  ProjectRejected: because(400),
  ProjectFileConflict: because(409),
  PushRejected: because(400),
  QuestionUnavailable: () => ({
    status: 409,
    body: localized(m.chat_error_question_unavailable),
  }),
  QueueEntryNotFound: () => ({
    status: 409,
    body: localized(m.chat_error_queue_entry_not_found),
  }),
  QueueFull: () => ({ status: 409, body: localized(m.chat_error_queue_full) }),
  ResumeNotAllowed: because(409),
  RetryNotAllowed: because(409),
  ScheduleChanged: because(409),
  ScheduleNotAvailable: notFound,
  ScheduleRejected: because(400),
  SharingNotAllowed: because(400),
  SharedResourceNotAvailable: notFound,
  SharingRateLimited: () => ({
    status: 429,
    body: localized(m.sharing_error_rate_limited),
    headers: { "Retry-After": "60" },
  }),
  SkillConflict: () => ({ status: 409, body: localized(m.skills_error_conflict) }),
  SkillNotAvailable: notFound,
  SkillRejected: because(400),
  StorageFull: because(413),
  ToolUnavailable: (error) => ({
    status: 400,
    body: localized(m.tools_error_web_search_unavailable, { reason: error.reason }),
  }),
  UnhostedImageFamily: because(400),
  UsageLimitReached: because(429),
  WorkDesktopRequired: () => ({
    status: 409,
    body: localized(m.chat_error_work_desktop_required),
  }),
};

export const refusalOf = <E extends Refusable>(error: E, overrides?: RefusalOverrides): Refusal => {
  const describe = overrides?.[error._tag] ?? refusals[error._tag];
  // Indexing by a union tag widens the function to every tag's; it is the one for E's.
  return (describe as (error: E) => Refusal)(error);
};

const responseOf = ({ body, ...init }: Refusal, locale: Locale) => new Response(body(locale), init);

/**
 * A refusal the function decides itself, with no failure behind it, to throw
 * from plain code, which still runs in the request and so knows its locale.
 * Start answers a thrown Response as it is, and `reportUnexpectedFailures`
 * lets it pass.
 */
export const refusal = (status: number, body: Localized | string) =>
  responseOf({ status, body: words(body) }, getLocale());

/** A refusal decided inside an effect, rendered by `refusing` once the request's locale is known. */
class PendingRefusal {
  constructor(readonly refusal: Refusal) {}
  /** What a log shows if one escapes `refusing`. */
  toString() {
    return `Refused ${this.refusal.status}: ${english(this.refusal.body)}`;
  }
}

/** The same refusal inside an effect. */
export const refuse = (status: number, body: Localized | string) =>
  Effect.die(new PendingRefusal({ status, body: words(body) }));

/** An error channel typed `any` meets every constraint, so it is refused outright. */
export type TypedErrors<E> = 0 extends 1 & E ? "the error channel is any" : unknown;

/**
 * Turns every expected failure into its refusal, worded in `locale`. The error
 * channel may hold only tags the table knows, so a failure from another module
 * cannot reach the boundary unmapped and surface as an unexpected 500. Other
 * defects stay defects.
 */
export const refusing = <A, E extends Refusable, R>(
  effect: Effect.Effect<A, E, R> & TypedErrors<E>,
  locale: Locale,
  overrides?: RefusalOverrides,
): Effect.Effect<A, never, R> =>
  effect.pipe(
    Effect.catch((error) => Effect.die(new PendingRefusal(refusalOf(error, overrides)))),
    Effect.catchDefect((defect) =>
      Effect.die(defect instanceof PendingRefusal ? responseOf(defect.refusal, locale) : defect),
    ),
  );
