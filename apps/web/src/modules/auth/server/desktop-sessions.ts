import { timingSafeEqual } from "node:crypto";
import {
  APIError,
  createAuthEndpoint,
  sensitiveSessionMiddleware,
  sessionMiddleware,
} from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import type { BetterAuthPlugin } from "better-auth";
import { Option, Schema } from "effect";
import { uuidv7 } from "uuidv7";
import {
  DESKTOP_SESSION_SECONDS,
  DESKTOP_TICKET_MINUTES,
  challengeOf,
  generateTicket,
  hasDesktopMarker,
  hashTicket,
  isTicketShaped,
  normaliseTicket,
  UNBOUND_TICKET,
} from "../desktop-ticket.ts";

const IDENTIFIER_PREFIX = "desktop-ticket:";

// One message for wrong, expired and already-used codes, so a guess learns
// nothing about which codes exist.
const INVALID_TICKET = "That code is not valid.";
const invalid = () => new APIError("BAD_REQUEST", { message: INVALID_TICKET });

const TicketBody = Schema.toStandardSchemaV1(
  Schema.Struct({ challenge: Schema.optionalKey(Schema.String) }),
);
const RedeemBody = Schema.toStandardSchemaV1(
  Schema.Struct({
    ticket: Schema.String,
    verifier: Schema.optionalKey(Schema.String),
    /**
     * Redeem only a code bound to a challenge, and leave any other untouched.
     * A deep link sets it: any page can open one, but only the shell that
     * opened the browser holds the verifier of a bound code.
     */
    boundOnly: Schema.optionalKey(Schema.Boolean),
  }),
);
const RevokeBody = Schema.toStandardSchemaV1(Schema.Struct({ id: Schema.String }));
const StoredTicket = Schema.Struct({
  userId: Schema.String,
  challenge: Schema.NullOr(Schema.String),
  ticketId: Schema.String,
});
const decodeStored = Schema.decodeUnknownOption(Schema.fromJsonString(StoredTicket));
const encodeStored = Schema.encodeSync(Schema.fromJsonString(StoredTicket));

const impersonated = (session: Record<string, unknown>) => Boolean(session.impersonatedBy);

const sameHash = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

const desktopExpiry = () => new Date(Date.now() + DESKTOP_SESSION_SECONDS * 1000);

/**
 * Sign-in for the desktop shell: the browser mints a short single-use ticket
 * and the shell redeems it for a session of its own, long-lived because a
 * desktop app is not expected to ask again every week. Tickets live in the
 * existing `verification` table, hashed, so no migration is needed.
 */
export const desktopSessions = ({
  approved,
  onRedeemed,
}: {
  /** Same rule `sessionFromHeaders` applies: a pending account mints nothing. */
  approved: (userId: string) => Promise<boolean>;
  /** Told after the desktop holds its cookie; a failure here is logged, never surfaced. */
  onRedeemed: (userId: string, ticketId: string) => Promise<void>;
}) =>
  ({
    id: "desktop-sessions",
    endpoints: {
      createDesktopTicket: createAuthEndpoint(
        "/desktop/ticket",
        { method: "POST", body: TicketBody, use: [sessionMiddleware] },
        async (ctx) => {
          const { session, user } = ctx.context.session;
          // An admin acting as someone else must not leave that person a
          // 90-day session, and an unapproved account may not use the app yet.
          if (impersonated(session) || !(await approved(user.id))) {
            throw new APIError("FORBIDDEN", { message: "This account cannot add a desktop." });
          }
          const ticket = generateTicket();
          // The handle the minting tab keeps to recognise its own redemption.
          const ticketId = uuidv7();
          const expiresAt = new Date(Date.now() + DESKTOP_TICKET_MINUTES * 60 * 1000);
          await ctx.context.internalAdapter.createVerificationValue({
            identifier: IDENTIFIER_PREFIX + (await hashTicket(ticket)),
            value: encodeStored({
              userId: user.id,
              challenge: ctx.body.challenge ?? null,
              ticketId,
            }),
            expiresAt,
          });
          return ctx.json({ ticket, ticketId, expiresAt: expiresAt.toISOString() });
        },
      ),

      redeemDesktopTicket: createAuthEndpoint(
        "/desktop/session",
        { method: "POST", body: RedeemBody },
        async (ctx) => {
          const ticket = normaliseTicket(ctx.body.ticket);
          // Shape check first so malformed input never reaches the store.
          if (!isTicketShaped(ticket)) throw invalid();
          const identifier = IDENTIFIER_PREFIX + (await hashTicket(ticket));
          // Read before consuming: an unbound code refused here must still
          // work when the person confirms it by hand.
          if (ctx.body.boundOnly) {
            const found = await ctx.context.internalAdapter.findVerificationValue(identifier);
            const peeked = found ? decodeStored(found.value) : Option.none();
            if (Option.isSome(peeked) && peeked.value.challenge === null)
              throw new APIError("CONFLICT", { message: UNBOUND_TICKET });
          }
          const consumed = await ctx.context.internalAdapter.consumeVerificationValue(identifier);
          if (!consumed) throw invalid();
          const stored = decodeStored(consumed.value);
          if (Option.isNone(stored)) throw invalid();
          const { userId, challenge, ticketId } = stored.value;
          // A ticket minted with a PKCE challenge belongs to the shell that
          // opened the browser; only that shell holds the verifier. A
          // paste-only ticket carries none and ignores whatever is sent.
          if (challenge !== null) {
            const verifier = ctx.body.verifier;
            if (!verifier || !sameHash(await challengeOf(verifier), challenge)) throw invalid();
          }
          const user = await ctx.context.internalAdapter.findUserById(userId);
          if (!user || (user as { banned?: boolean | null }).banned || !(await approved(userId)))
            throw invalid();
          // `overrideAll` applies the override after the adapter's own 7-day
          // default; without it the longer expiry is silently replaced.
          const session = await ctx.context.internalAdapter.createSession(
            userId,
            false,
            { expiresAt: desktopExpiry() },
            true,
          );
          await setSessionCookie(ctx, { session, user }, false, {
            maxAge: DESKTOP_SESSION_SECONDS,
          });
          // The desktop is signed in by now; a lost hint costs the minting
          // tab a refresh, so it must never turn into a failed redemption.
          try {
            await onRedeemed(userId, ticketId);
          } catch (error) {
            ctx.context.logger.error("desktop session hint failed", error);
          }
          // The session record carries the bearer token; the cookie is the
          // only place it belongs.
          return ctx.json({ ok: true as const });
        },
      ),

      refreshDesktopSession: createAuthEndpoint(
        "/desktop/session/refresh",
        { method: "POST", use: [sessionMiddleware] },
        async (ctx) => {
          const { session, user } = ctx.context.session;
          // Only a session minted by the shell (its stored UA carries the
          // product token) gets the long lease, and never while impersonating.
          if (
            !hasDesktopMarker(session.userAgent) ||
            impersonated(session) ||
            !(await approved(user.id))
          ) {
            throw new APIError("FORBIDDEN", { message: "Only the desktop app can do this." });
          }
          const updated = await ctx.context.internalAdapter.updateSession(session.token, {
            expiresAt: desktopExpiry(),
            updatedAt: new Date(),
          });
          if (!updated) throw new APIError("UNAUTHORIZED", { message: "Session not found." });
          await setSessionCookie(ctx, { session: updated, user }, false, {
            maxAge: DESKTOP_SESSION_SECONDS,
          });
          return ctx.json({ ok: true as const, expiresAt: updated.expiresAt.toISOString() });
        },
      ),

      /**
       * The device list for Settings. Better Auth's own `listSessions` sits
       * behind the freshness check, which shuts a day-old browser out of the
       * page, and returns each session's bearer token; this one does neither.
       */
      listDesktopDevices: createAuthEndpoint(
        "/desktop/devices",
        { method: "GET", use: [sessionMiddleware] },
        async (ctx) => {
          const { session, user } = ctx.context.session;
          if (!(await approved(user.id)))
            throw new APIError("FORBIDDEN", { message: "This account cannot list devices." });
          const sessions = await ctx.context.internalAdapter.listSessions(user.id, {
            onlyActiveSessions: true,
          });
          return ctx.json(
            sessions.map(({ id, userAgent, ipAddress, createdAt, updatedAt, expiresAt }) => ({
              id,
              userAgent: userAgent ?? null,
              ipAddress: ipAddress ?? null,
              createdAt: createdAt.toISOString(),
              updatedAt: updatedAt.toISOString(),
              expiresAt: expiresAt.toISOString(),
              current: id === session.id,
            })),
          );
        },
      ),

      revokeDesktopDevice: createAuthEndpoint(
        "/desktop/devices/revoke",
        { method: "POST", body: RevokeBody, use: [sensitiveSessionMiddleware] },
        async (ctx) => {
          const { session, user } = ctx.context.session;
          if (impersonated(session) || !(await approved(user.id))) {
            throw new APIError("FORBIDDEN", { message: "This account cannot sign out devices." });
          }
          if (ctx.body.id === session.id) {
            throw new APIError("BAD_REQUEST", { message: "Use sign out for this device." });
          }
          // Looked up among the caller's own sessions, so another user's id
          // is indistinguishable from one that never existed.
          const target = (await ctx.context.internalAdapter.listSessions(user.id)).find(
            (candidate) => candidate.id === ctx.body.id,
          );
          if (target) await ctx.context.internalAdapter.deleteSession(target.token);
          return ctx.json({ ok: true as const });
        },
      ),
    },
    // Redemption is the one endpoint a stranger can hit with guesses.
    rateLimit: [{ pathMatcher: (path) => path === "/desktop/session", window: 60, max: 5 }],
  }) satisfies BetterAuthPlugin;
