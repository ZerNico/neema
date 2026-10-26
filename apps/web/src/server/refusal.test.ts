import { Effect, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { defineServerRegion } from "~/i18n/formats.ts";
import { localized, verbatim } from "~/i18n/localized.ts";
import { QueueFull } from "~/modules/chat/errors.ts";
import { SharingRateLimited } from "~/modules/sharing/errors.ts";
import { m } from "~/paraglide/messages.js";
import { SkillNotAvailable, SkillRejected } from "~/modules/skills/errors.ts";
import { UNEXPECTED_FAILURE, readServerError } from "~/server-error.ts";
import { NOT_FOUND, refuse, refusing } from "./refusal.ts";
import { reportUnexpectedFailures } from "./unexpected-failure.ts";

vi.mock("@tanstack/react-start", () => ({
  createMiddleware: () => ({ server: (handler: unknown) => handler }),
}));
// The middleware logs through the app runtime; a plain one keeps the database out.
vi.mock("./runtime.ts", () => ({
  runtime: { runPromise: (effect: Effect.Effect<unknown>) => Effect.runPromise(effect) },
}));

class Unmapped extends Schema.TaggedError<Unmapped>()("Unmapped", {}) {}

const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );

const refusalFrom = async (effect: Effect.Effect<unknown, never>) => {
  const thrown = await rejection(Effect.runPromise(effect));
  if (!(thrown instanceof Response)) throw new Error("expected a Response");
  return {
    status: thrown.status,
    body: await thrown.text(),
    retryAfter: thrown.headers.get("Retry-After"),
  };
};

type Middleware = (input: { next: () => Promise<unknown> }) => Promise<unknown>;
// The mock above makes the registered handler the middleware itself.
const report: unknown = reportUnexpectedFailures;

describe("refusing", () => {
  it("answers a known failure with its status and body", async () => {
    expect(
      await refusalFrom(
        refusing(Effect.fail(new SkillRejected({ reason: verbatim("Name is taken") })), "en"),
      ),
    ).toEqual({ status: 400, body: "Name is taken", retryAfter: null });
    expect(await refusalFrom(refusing(Effect.fail(new SharingRateLimited()), "en"))).toMatchObject({
      status: 429,
      retryAfter: "60",
    });
  });

  it("gives every miss the one 404 body the client treats as saying nothing", async () => {
    const refusal = await refusalFrom(
      refusing(Effect.fail(new SkillNotAvailable({ skillId: "s1" })), "de"),
    );
    expect(refusal).toMatchObject({ status: 404, body: NOT_FOUND });
    expect(readServerError(new Error(refusal.body)).reason).toBeNull();
  });

  it("lets a caller reword one tag", async () => {
    expect(
      await refusalFrom(
        refusing(Effect.fail(new SkillNotAvailable({ skillId: "s1" })), "en", {
          SkillNotAvailable: () => ({ status: 404, body: verbatim("Pick another skill") }),
        }),
      ),
    ).toMatchObject({ status: 404, body: "Pick another skill" });
  });

  it("words a refusal in the request's locale, also one decided inside the effect", async () => {
    expect(
      await refusalFrom(refusing(Effect.fail(new QueueFull({ conversationId: "c1" })), "de")),
    ).toMatchObject({
      status: 409,
      body: "Zu viele Nachrichten in der Warteschlange",
    });
    const decided = refuse(409, localized(m.chat_error_not_started));
    expect(await refusalFrom(refusing(decided, "de"))).toMatchObject({
      status: 409,
      body: "Diese Nachricht konnte nicht gestartet werden",
    });
    expect(await refusalFrom(refusing(decided, "en"))).toMatchObject({
      body: "This message could not be started",
    });
  });

  it("hands the body the request's format, read before the effect runs", async () => {
    defineServerRegion(() => "CH");
    const refused = refusing(
      refuse(413, (locale, formats) => `${locale} ${formats}`),
      "de",
    );
    // A later request's region must not reach a refusal already decided on.
    defineServerRegion(() => "AT");
    expect(await refusalFrom(refused)).toMatchObject({ body: "de de-CH" });
    defineServerRegion(() => undefined);
  });

  it("leaves a defect to the unexpected-failure path", async () => {
    const defect = new Error('relation "secret" does not exist');
    const thrown = await rejection(Effect.runPromise(refusing(Effect.die(defect), "en")));
    expect(thrown).toBe(defect);

    const answered = await rejection(
      (report as Middleware)({
        next: () => Effect.runPromise(refusing(Effect.die(defect), "en")),
      }),
    );
    if (!(answered instanceof Response)) throw new Error("expected a Response");
    expect(answered.status).toBe(500);
    const body = await answered.text();
    expect(body.startsWith(UNEXPECTED_FAILURE)).toBe(true);
    expect(body).not.toContain("secret");
  });

  it("refuses at compile time a failure the table does not know", () => {
    // Only the types are under test; the runner itself would build the app runtime.
    const typed = (run: typeof import("./run-server-fn.ts").runServerFn) => {
      // @ts-expect-error Unmapped has no refusal, so it must be handled before the boundary.
      void run(Effect.fail(new Unmapped()));
      // @ts-expect-error Neither may a plain Error, whose message is not for the client.
      void run(Effect.fail(new Error("boom")));
      // @ts-expect-error An error channel typed any would otherwise meet the constraint.
      void run(Effect.fail(JSON.parse("{}")));
      void run(Effect.fail(new SkillRejected({ reason: verbatim("ok") })));
      // @ts-expect-error The pure transform carries the same constraint.
      void refusing(Effect.fail(new Unmapped()));
    };
    expect(typed).toBeTypeOf("function");
  });
});
