import { Effect, Stream } from "effect";
import { expect, it, vi } from "vitest";
import type { SyncEvent } from "~/modules/sync/events.ts";
import type { SyncBus } from "~/modules/sync/server/bus.ts";
import { approvalEvents } from "./approval-events.ts";

it("emits only empty approval/readiness wakeups and requests an account-only subscription", async () => {
  const events: SyncEvent[] = [
    { type: "sync.ready" },
    { type: "memory.changed" },
    { type: "desktop.session.created", ticketId: "private" },
    { type: "account.approval.changed" },
    { type: "conversation.created", conversationId: "private" },
    { type: "sync.ready" },
  ];
  const subscribe = vi.fn(() => Stream.fromIterable(events));
  const bus: SyncBus["Service"] = {
    subscribe,
    publish: () => Effect.void,
    publishGlobal: () => Effect.void,
    signals: Stream.never,
  };
  const output = await Effect.runPromise(Stream.runCollect(approvalEvents(bus, "waiting-user")));
  expect(subscribe).toHaveBeenCalledWith("waiting-user", true);
  expect(output).toEqual([null, null, null]);
});
