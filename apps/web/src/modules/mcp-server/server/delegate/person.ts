import { inputRequired, inputResponse, type InputRequest } from "@modelcontextprotocol/server";
import { Effect, Option, Schema, Stream } from "effect";
import { schemaOf } from "~/modules/integrations/mcp/server/elicitation.ts";
import { IntegrationApprovals } from "~/modules/integrations/server/approvals.ts";
import { IntegrationRepo } from "~/modules/integrations/server/repo.ts";
import {
  AnswerElicitationInput,
  approvalConsequence,
  type ElicitationAnswer,
  type PendingIntegrationCall,
} from "~/modules/integrations/schema.ts";
import { toolText } from "~/modules/integrations/tool-text.ts";
import { LanguageRepo } from "~/modules/language/server/repo.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { m } from "~/paraglide/messages.js";
import type { Locale } from "~/paraglide/runtime.js";
import type { PersonAsk } from "../request-state.ts";

const decodeAnswer = Schema.decodeUnknownOption(AnswerElicitationInput);

/** The calls on this answer waiting for the person: approvals, and questions a service asked. */
export const waitingOn = Effect.fn("mcp.waitingOn")(function* (userId: string, messageId: string) {
  const approvals = yield* IntegrationApprovals;
  const pending = yield* approvals.pending(userId);
  return pending.filter((call) => call.messageId === messageId);
});

/** One parked entry: the call and which of its questions, since a call may ask several. */
export const callKey = (call: { callId: string; promptId: string }) =>
  `${call.callId}:${call.promptId}`;

/**
 * Ends once this answer waits on the person for something not in `known`.
 * Subscribed before the first look, so a call parked in between is not missed.
 */
export const waitForPerson = (input: {
  userId: string;
  conversationId: string;
  messageId: string;
  known: ReadonlySet<string>;
}) =>
  Effect.flatMap(SyncBus, (bus) =>
    bus.subscribe(input.userId, true).pipe(
      Stream.filter(
        (event) =>
          event.type === "sync.ready" ||
          (event.type === "integration.approval.changed" &&
            event.conversationId === input.conversationId),
      ),
      Stream.mapEffect(() => waitingOn(input.userId, input.messageId)),
      Stream.filter((calls) => calls.some((call) => !input.known.has(callKey(call)))),
      Stream.runHead,
    ),
  );

export const knownCalls = (calls: ReadonlyArray<PendingIntegrationCall>) =>
  new Set(calls.map(callKey));

/** What the client says it can put to its person, from this request's own capabilities. */
export const elicitationSupport = (capabilities: unknown) => {
  const elicitation =
    typeof capabilities === "object" && capabilities !== null && "elicitation" in capabilities
      ? (capabilities.elicitation as Record<string, unknown> | undefined)
      : undefined;
  if (typeof elicitation !== "object" || elicitation === null) return { form: false, url: false };
  // An empty capability predates the two modes and means forms.
  const neither = !("form" in elicitation) && !("url" in elicitation);
  return { form: neither || "form" in elicitation, url: "url" in elicitation };
};

/** Whether a client with this support can put this call to its person. */
export const askable = (call: PendingIntegrationCall, support: { form: boolean; url: boolean }) =>
  call.kind === "approval"
    ? support.form
    : call.prompt?.mode === "form"
      ? support.form
      : call.prompt?.mode === "url" && support.url;

/** The approval form, in the person's language: their client shows these titles. */
const decisionSchema = (locale: Locale) => ({
  type: "object" as const,
  properties: {
    decision: {
      type: "string" as const,
      title: m.integrations_approval_decision({}, { locale }),
      oneOf: [
        { const: "allow", title: m.integrations_approval_allow({}, { locale }) },
        { const: "deny", title: m.integrations_approval_deny({}, { locale }) },
      ],
    },
  },
  required: ["decision"],
});

/** What the in-app card shows, as one message: a person approves what they can see. */
const approvalMessage = (
  call: PendingIntegrationCall,
  service: string,
  kind: string | undefined,
  locale: Locale,
) =>
  [
    m.integrations_approval_question(
      {
        label: toolText(kind, { name: call.tool, label: call.label }, locale).label,
        name: service,
      },
      { locale },
    ),
    call.inFull
      ? `${m.integrations_approval_everything_lead({}, { locale })}\n${call.inFull}`
      : call.details?.length
        ? call.details
            .map(
              (detail) =>
                `${detail.key}: ${detail.value || m.integrations_approval_empty({}, { locale })}`,
            )
            .join("\n")
        : call.summary,
    call.targets.length
      ? m.integrations_approval_recipients_lead({ targets: call.targets.join(", ") }, { locale })
      : null,
    approvalConsequence(call, service, locale),
  ]
    .filter(Boolean)
    .join("\n\n");

/**
 * The questions to put to the client's person, or null for a call this client
 * cannot show (a page to visit, where it takes forms only). Keys are positional;
 * the request state says which call each one answers.
 */
export const askPerson = Effect.fn("mcp.askPerson")(function* (
  userId: string,
  calls: ReadonlyArray<PendingIntegrationCall>,
  support: { form: boolean; url: boolean },
) {
  const integrations = yield* IntegrationRepo;
  // Their client shows it to them, with no page of ours to know their language.
  const locale = yield* (yield* LanguageRepo).localeOf(userId);
  const requests: Record<string, InputRequest> = {};
  const asks: PersonAsk[] = [];
  for (const [index, call] of calls.entries()) {
    const key = `ask-${index}`;
    const config = yield* integrations.getConfig(call.integrationId);
    const service = config?.name ?? m.integrations_approval_service_fallback({}, { locale });
    const prompt = call.prompt;
    if (call.kind === "approval" && support.form) {
      requests[key] = inputRequired.elicit({
        message: approvalMessage(call, service, config?.kind, locale),
        requestedSchema: decisionSchema(locale),
      });
      asks.push({
        key,
        callId: call.callId,
        promptId: call.promptId,
        kind: "approval",
        label: call.label,
      });
    } else if (prompt?.mode === "form" && support.form) {
      requests[key] = inputRequired.elicit({
        message: m.integrations_approval_service_asks(
          { service, message: prompt.message },
          { locale },
        ),
        requestedSchema: schemaOf(prompt.fields),
      });
      asks.push({
        key,
        callId: call.callId,
        promptId: call.promptId,
        kind: "form",
        label: call.label,
      });
    } else if (prompt?.mode === "url" && support.url) {
      requests[key] = inputRequired.elicitUrl({
        message: m.integrations_approval_service_asks(
          { service, message: prompt.message },
          { locale },
        ),
        url: prompt.url,
      });
      asks.push({
        key,
        callId: call.callId,
        promptId: call.promptId,
        kind: "url",
        label: call.label,
      });
    }
  }
  return asks.length ? { requests, asks } : null;
});

/**
 * Settles what the person answered in the client. A stale nonce, or a call
 * that ended meanwhile, settles nothing; a dismissed question is left for the
 * card in the app, which still shows it.
 */
export const settleAnswers = Effect.fn("mcp.settleAnswers")(function* (input: {
  userId: string;
  asks: ReadonlyArray<PersonAsk>;
  responses: Record<string, unknown> | undefined;
  app: string;
}) {
  const approvals = yield* IntegrationApprovals;
  /** Answered in the client after the call stopped waiting, so nothing came of it. */
  const late: string[] = [];
  for (const ask of input.asks) {
    const response = inputResponse(input.responses, ask.key);
    if (response.kind !== "elicit" || response.action === "cancel") continue;
    if (ask.kind === "approval") {
      const decision = response.content?.["decision"];
      // Declining the form is declining the call; anything else is no answer.
      const answer =
        response.action === "decline"
          ? "deny"
          : decision === "allow" || decision === "deny"
            ? decision
            : null;
      if (!answer) continue;
      const settled = yield* approvals.decide(input.userId, ask.callId, answer, {
        promptId: ask.promptId,
        via: input.app,
      });
      if (!settled) late.push(ask.label);
      continue;
    }
    // Read as the card's answers are, then checked against the service's
    // form where it is sent on; what does not read is declined, never half-sent.
    const read = Option.getOrNull(
      decodeAnswer({
        callId: ask.callId,
        promptId: ask.promptId,
        action: response.action,
        ...(ask.kind === "form" && response.content ? { values: response.content } : {}),
      }),
    );
    const answer: ElicitationAnswer =
      !read || read.action === "decline"
        ? { action: "decline" }
        : { action: "accept", ...(read.values ? { values: read.values } : {}) };
    if (!(yield* approvals.answer(input.userId, ask.callId, ask.promptId, answer)))
      late.push(ask.label);
  }
  return late;
});
