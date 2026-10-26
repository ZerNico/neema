import { beforeEach, describe, expect, it, vi } from "vitest";
import { Effect, Layer } from "effect";
import { UNAUTHENTICATED_BODY } from "~/modules/auth/identity.ts";
import { NOT_APPROVED_BODY } from "~/modules/auth/signup.ts";
import { AccountIneligible } from "~/modules/auth/server/account-eligibility.ts";
import { IntegrationNotAvailable } from "~/modules/integrations/errors.ts";
import { ModelNotFound } from "../errors.ts";
import type { ChatService as ChatServiceContext } from "./service.ts";
import {
  answerQuestion,
  dispatchQueuedMessage,
  editMessage,
  resumeMessage,
  retryMessage,
  sendMessage,
  sendQueuedNow,
} from "./functions.ts";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  attempt:
    vi.fn<
      (input: {
        userId: string;
      }) => Effect.Effect<never, AccountIneligible | IntegrationNotAvailable | ModelNotFound>
    >(),
}));
vi.mock("~/modules/auth/server/auth.ts", () => ({ sessionFromHeaders: mocks.session }));

// Run the registered handler, validator and real session middleware without a Start server.
vi.mock("@tanstack/react-start", () => ({
  createMiddleware: () => ({ server: (handler: unknown) => handler }),
  createServerFn: () => {
    type BoundaryContext = { session: { user: { id: string }; session: { id: string } } };
    type Middleware = (input: {
      request: Request;
      next: (input: { context: BoundaryContext }) => Promise<unknown>;
    }) => Promise<unknown>;
    type Validation = { value?: unknown; issues?: unknown };
    let middleware: Middleware[] = [];
    let validator:
      | {
          "~standard": { validate: (data: unknown) => Validation | Promise<Validation> };
        }
      | undefined;
    const builder = {
      middleware: (value: Middleware[]) => {
        middleware = value;
        return builder;
      },
      validator: (value: typeof validator) => {
        validator = value;
        return builder;
      },
      handler:
        (handler: (input: { data: unknown; context: BoundaryContext }) => unknown) =>
        async ({ data }: { data: unknown }) => {
          const execute = async (index: number, context?: BoundaryContext): Promise<unknown> => {
            if (middleware[index])
              return middleware[index]({
                request: new Request("http://test/chat"),
                next: (input) => execute(index + 1, input.context),
              });
            const result = await validator?.["~standard"].validate(data);
            if (result?.issues) throw new Error("Invalid input");
            if (!context) throw new Error("Missing session context");
            return handler({ data: result?.value ?? data, context });
          };
          return execute(0);
        },
    };
    return builder;
  },
}));
vi.mock("~/server/runtime.ts", async () => {
  const { ChatService } = await import("./service.ts");
  const service = Layer.mock(ChatService, {
    sendMessage: mocks.attempt,
    retryMessage: mocks.attempt,
    resumeMessage: mocks.attempt,
    editMessage: mocks.attempt,
    dispatchQueuedMessage: mocks.attempt,
    sendQueuedNow: mocks.attempt,
  });
  return {
    runtime: {
      runPromise: (effect: Effect.Effect<unknown, unknown, ChatServiceContext>) =>
        Effect.runPromise(effect.pipe(Effect.provide(service))),
    },
  };
});

const submission = {
  conversation: { kind: "existing" as const, id: "chat" },
  modelId: "model",
  content: "Synthetic message",
  attachmentIds: [],
  searchEnabled: false,
  researchEnabled: false,
};
const message = { conversationId: "chat", messageId: "message" };
const promotions = [
  { name: "dispatch", run: () => dispatchQueuedMessage({ data: { conversationId: "chat" } }) },
  {
    name: "send queued now",
    run: () => sendQueuedNow({ data: { conversationId: "chat", entryId: "entry" } }),
  },
];
const boundaries = [
  { name: "send", run: () => sendMessage({ data: submission }) },
  {
    name: "answer",
    run: () =>
      answerQuestion({
        data: {
          conversationId: "chat",
          callId: "question",
          response: { kind: "answers", answers: [{ selected: [0], custom: "" }] },
          modelId: "model",
        },
      }),
  },
  { name: "retry", run: () => retryMessage({ data: message }) },
  { name: "resume", run: () => resumeMessage({ data: message }) },
  { name: "edit", run: () => editMessage({ data: { ...submission, ...message } }) },
  ...promotions,
];

const refusal = async (promise: Promise<unknown>) => {
  const error: unknown = await promise.then(
    () => null,
    (failure: unknown) => failure,
  );
  if (!(error instanceof Response)) throw new Error("Expected an HTTP refusal");
  return { status: error.status, body: await error.text() };
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({
    approved: true,
    session: { user: { id: "actor" }, session: { id: "origin" } },
  });
});

describe.each(boundaries)("$name acceptance boundary", ({ run }) => {
  it.each([
    { reason: "unapproved" as const, status: 403, body: NOT_APPROVED_BODY },
    { reason: "missing" as const, status: 401, body: UNAUTHENTICATED_BODY },
    { reason: "banned" as const, status: 401, body: UNAUTHENTICATED_BODY },
  ])("maps transaction-time $reason after session approval", async ({ reason, status, body }) => {
    mocks.attempt.mockReturnValue(Effect.fail(new AccountIneligible({ userId: "actor", reason })));
    expect(await refusal(run())).toEqual({ status, body });
    expect(mocks.attempt).toHaveBeenCalledOnce();
    expect(mocks.attempt.mock.calls[0]?.[0].userId).toBe("actor");
  });

  it("still rejects an unauthenticated request before the service", async () => {
    mocks.session.mockResolvedValue(null);
    expect(await refusal(run())).toEqual({ status: 401, body: UNAUTHENTICATED_BODY });
    expect(mocks.attempt).not.toHaveBeenCalled();
  });
});

const selectedIntegrations = [{ connectionId: "connection", enabled: true }];
const integrationSelections = [
  {
    name: "send",
    run: () => sendMessage({ data: { ...submission, integrationChoices: selectedIntegrations } }),
  },
];

describe.each(integrationSelections)("$name selected integration", ({ run }) => {
  it("maps an unavailable atomic selection to a readable 404", async () => {
    mocks.attempt.mockReturnValue(
      Effect.fail(new IntegrationNotAvailable({ integrationId: "integration" })),
    );
    expect(await refusal(run())).toEqual({
      status: 404,
      body: "A selected integration is not available",
    });
    expect(mocks.attempt).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ userId: "actor", integrationChoices: selectedIntegrations }),
    );
  });
});

describe.each(promotions)("$name queue failures", ({ run }) => {
  it("retains the generic conflict for a non-auth resolution failure", async () => {
    mocks.attempt.mockReturnValue(Effect.fail(new ModelNotFound({ modelId: "model" })));
    expect(await refusal(run())).toEqual({
      status: 409,
      body: "This message could not be started",
    });
  });
});
