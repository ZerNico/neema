import { Effect } from "effect";
import type { AgentNotAvailable, AgentRejected } from "~/modules/agents/errors.ts";
import type {
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
  GroupMemberNotFound,
  GroupNameTaken,
  GroupNotFound,
} from "~/modules/groups/errors.ts";
import type { IntegrationNotAvailable } from "~/modules/integrations/errors.ts";
import type {
  KnowledgeNotAvailable,
  KnowledgeRejected,
  SharingNotAllowed,
} from "~/modules/knowledge/errors.ts";
import type { MailFailed } from "~/modules/notifications/server/mail.ts";
import type { PushRejected } from "~/modules/notifications/server/push.ts";
import type { FontRejected } from "~/modules/presentations/server/fonts.ts";
import type { ProjectNotAvailable, ProjectRejected } from "~/modules/projects/errors.ts";
import type {
  InvalidDefaultModelOrder,
  InvalidUtilityModel,
  UnhostedImageFamily,
} from "~/modules/providers/default-models.ts";
import type { ScheduleNotAvailable, ScheduleRejected } from "~/modules/schedules/schema.ts";
import type { SharingRateLimited } from "~/modules/sharing/errors.ts";
import type { SkillConflict, SkillNotAvailable, SkillRejected } from "~/modules/skills/errors.ts";
import type { InvalidSearchProvider } from "~/modules/tools/server/search-provider-repo.ts";
import type { ToolUnavailable } from "~/modules/tools/server/web-search.ts";

/** How a server function answers a failure it expected: a status and a body the page may show. */
export interface Refusal {
  readonly status: number;
  readonly body: string;
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
  | AttachmentNotAvailable
  | AttachmentRejected
  | AttachmentUnsupported
  | BranchNotAllowed
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
  | PushRejected
  | QuestionUnavailable
  | QueueEntryNotFound
  | QueueFull
  | ResumeNotAllowed
  | RetryNotAllowed
  | ScheduleNotAvailable
  | ScheduleRejected
  | SharingNotAllowed
  | SharingRateLimited
  | SkillConflict
  | SkillNotAvailable
  | SkillRejected
  | ToolUnavailable
  | UnhostedImageFamily
  | WorkDesktopRequired;

export type RefusalTable = {
  readonly [Tag in Refusable["_tag"]]: (error: Extract<Refusable, { _tag: Tag }>) => Refusal;
};

/** Another wording for a tag where one caller's page needs it; the status is the caller's too. */
export type RefusalOverrides = Partial<RefusalTable>;

const notFound = (): Refusal => ({ status: 404, body: NOT_FOUND });
const because =
  (status: number) =>
  (error: { readonly reason: string }): Refusal => ({ status, body: error.reason });

const refusals: RefusalTable = {
  AccountIneligible: (error) =>
    error.reason === "unapproved"
      ? { status: 403, body: NOT_APPROVED_BODY }
      : { status: 401, body: UNAUTHENTICATED_BODY },
  AgentNotAvailable: notFound,
  AgentRejected: because(400),
  AttachmentNotAvailable: notFound,
  AttachmentRejected: (error) => ({
    status: error.cause === "size" ? 413 : 415,
    body: error.reason,
  }),
  AttachmentUnsupported: (error) => ({ status: 400, body: `${error.fileName}: ${error.reason}` }),
  BranchNotAllowed: because(409),
  ConversationBusy: () => ({ status: 409, body: "A response is still generating" }),
  ConversationNotFound: notFound,
  CustomToolCompileFailed: (error) => ({ status: 400, body: error.message }),
  CustomToolConflict: () => ({
    status: 409,
    body: "This module changed elsewhere; reload it before saving.",
  }),
  CustomToolNotFound: notFound,
  CustomToolSlugTaken: (error) => ({
    status: 409,
    body: `The slug ${error.slug} is already in use.`,
  }),
  DocumentNotAvailable: notFound,
  DocumentRejected: because(400),
  DraftNotAvailable: notFound,
  DraftRejected: because(400),
  EditNotAllowed: because(409),
  FontRejected: because(400),
  GroupMemberNotFound: notFound,
  GroupNameTaken: () => ({ status: 409, body: "Group name already taken" }),
  GroupNotFound: notFound,
  IntegrationNotAvailable: notFound,
  InvalidDefaultModelOrder: because(400),
  InvalidMessage: because(400),
  InvalidSearchProvider: because(400),
  InvalidUtilityModel: because(400),
  KnowledgeNotAvailable: notFound,
  KnowledgeRejected: because(400),
  MailFailed: because(400),
  MessageNotFound: notFound,
  ModelNotFound: () => ({ status: 400, body: "Unknown model" }),
  NoActiveGeneration: () => ({ status: 409, body: "That response already finished" }),
  ProjectNotAvailable: notFound,
  ProjectRejected: because(400),
  PushRejected: because(400),
  QuestionUnavailable: () => ({
    status: 409,
    body: "These questions are no longer available. Refresh the conversation.",
  }),
  QueueEntryNotFound: () => ({
    status: 409,
    body: "This queued message already started or was removed",
  }),
  QueueFull: () => ({ status: 409, body: "Too many messages are queued" }),
  ResumeNotAllowed: because(409),
  RetryNotAllowed: because(409),
  ScheduleNotAvailable: notFound,
  ScheduleRejected: because(400),
  SharingNotAllowed: because(400),
  SharingRateLimited: () => ({
    status: 429,
    body: "Too many sharing requests; try again shortly",
    headers: { "Retry-After": "60" },
  }),
  SkillConflict: () => ({
    status: 409,
    body: "This skill changed in another editor. Your draft is preserved; review the current revision before saving.",
  }),
  SkillNotAvailable: notFound,
  SkillRejected: because(400),
  ToolUnavailable: (error) => ({ status: 400, body: `Web search unavailable: ${error.reason}` }),
  UnhostedImageFamily: because(400),
  WorkDesktopRequired: () => ({
    status: 409,
    body: "This is a work chat; continue it from the desktop app",
  }),
};

export const refusalOf = <E extends Refusable>(error: E, overrides?: RefusalOverrides): Refusal => {
  const describe = overrides?.[error._tag] ?? refusals[error._tag];
  // Indexing by a union tag widens the function to every tag's; it is the one for E's.
  return (describe as (error: E) => Refusal)(error);
};

const responseOf = ({ body, ...init }: Refusal) => new Response(body, init);

/**
 * A refusal the function decides itself, with no failure behind it, to throw
 * from plain code. Start answers a thrown Response as it is, and
 * `reportUnexpectedFailures` lets it pass.
 */
export const refusal = (status: number, body: string) => responseOf({ status, body });

/** The same refusal inside an effect. */
export const refuse = (status: number, body: string) => Effect.die(refusal(status, body));

/** An error channel typed `any` meets every constraint, so it is refused outright. */
export type TypedErrors<E> = 0 extends 1 & E ? "the error channel is any" : unknown;

/**
 * Turns every expected failure into its refusal. The error channel may hold
 * only tags the table knows, so a failure from another module cannot reach the
 * boundary unmapped and surface as an unexpected 500. Defects stay defects.
 */
export const refusing = <A, E extends Refusable, R>(
  effect: Effect.Effect<A, E, R> & TypedErrors<E>,
  overrides?: RefusalOverrides,
): Effect.Effect<A, never, R> =>
  effect.pipe(Effect.catch((error) => Effect.die(responseOf(refusalOf(error, overrides)))));
