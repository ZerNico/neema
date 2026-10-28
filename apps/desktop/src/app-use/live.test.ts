import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { chatKey } from "./chat-key.ts";
import { type LiveDriver, LiveView } from "./live.ts";

const SERVER = "https://chat.example";
const A = chatKey(SERVER, "a");
const B = chatKey(SERVER, "b");
const ELSEWHERE = chatKey("https://other.example", "a");

/** A driver whose look is held by `holder`; the test decides when each picture comes back. */
const driver = () => {
  let taken = 0;
  const fake = {
    holder: null as string | null,
    running: true as boolean,
    resolve: null as (() => void) | null,
    call: vi.fn<LiveDriver["call"]>(() => {
      const picture = ++taken;
      return new Promise((resolve) => {
        fake.resolve = () => resolve({ data: `picture ${picture}`, width: 10, height: 20 });
      });
    }),
  } satisfies LiveDriver & { resolve: (() => void) | null };
  return fake;
};

const call = (name = "app_click") => ({ name, args: { app: "Calculator" }, app: "Calculator" });

let fake: ReturnType<typeof driver>;
let live: LiveView;
beforeEach(() => {
  vi.useFakeTimers();
  fake = driver();
  live = new LiveView({
    driver: fake,
    locale: async () => "en",
  });
});
afterEach(() => {
  live.close();
  vi.useRealTimers();
});

const settle = () => vi.advanceTimersByTimeAsync(0);

describe("a chat's live view", () => {
  test("pictures only the chat whose look the driver holds", async () => {
    fake.holder = A;
    live.begin(A, call());
    live.begin(B, call());
    fake.resolve?.();
    await settle();
    expect(live.update(A)?.frame?.data).toBe("picture 1");
    expect(live.update(B)?.frame).toBeNull();
  });

  test("drops a picture that comes back after the look changed hands", async () => {
    fake.holder = A;
    live.begin(A, call());
    live.begin(B, call());
    // B looks while A's picture is still being taken: it shows B's window now.
    fake.holder = B;
    fake.resolve?.();
    await settle();
    expect(live.update(A)?.frame).toBeNull();
  });

  test("takes no picture without a running driver, and never starts one", async () => {
    fake.holder = A;
    fake.running = false;
    live.begin(A, call());
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.call).not.toHaveBeenCalled();
  });

  test("refuses a paused chat's calls until it is resumed, bringing its view back", async () => {
    live.begin(A, call());
    live.finished(A);
    live.pause(A, true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(live.update(A)).toMatchObject({ live: false, spell: 1 });
    // The model tries again, and is told to send the person to Resume: the view comes back.
    expect(live.begin(A, call())).toBe(false);
    expect(live.update(A)).toMatchObject({ live: true, spell: 2, label: "Paused" });
    live.pause(A, false);
    expect(live.begin(A, call())).toBe(true);
  });

  test("says what happens in the person's language", async () => {
    live.begin(A, call("app_click"));
    expect(live.update(A)).toMatchObject({ label: "Clicking in Calculator", busy: true });
    live.yielded(A);
    expect(live.update(A)).toMatchObject({
      label: "Waiting while you use Calculator",
      busy: false,
    });
    // Between calls it still waits for them, until the next call goes ahead.
    live.finished(A);
    expect(live.update(A)?.label).toBe("Waiting while you use Calculator");
    live.begin(A, call("app_look"));
    live.finished(A);
    expect(live.update(A)?.label).toBe("neema is using Calculator");
    live.begin(A, call("app_click"));
    live.yielded(A);
    live.finished(A);
    // Waiting for the person lasts the spell, not beyond it.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(live.update(A)).toMatchObject({ label: "Done", live: false });

    const german = new LiveView({
      driver: fake,
      locale: async () => "de",
    });
    german.begin(A, call("app_type"));
    await settle();
    expect(german.update(A)?.label).toBe("Tippe in Calculator");
    german.close();
  });

  test("counts a new spell only after the chat went quiet", async () => {
    live.begin(A, call());
    live.finished(A);
    live.begin(A, call());
    expect(live.update(A)?.spell).toBe(1);
    live.finished(A);
    await vi.advanceTimersByTimeAsync(20_000);
    live.begin(A, call());
    expect(live.update(A)?.spell).toBe(2);
  });
});

describe("a page", () => {
  test("is told only of the chats it asked about, its person's own", () => {
    live.begin(A, call());
    expect(live.told(A)).toBe(false);
    expect(live.view(A)?.label).toBe("Clicking in Calculator");
    expect(live.told(A)).toBe(true);
    // Another server's page loading afresh forgets only what it asked about.
    live.view(ELSEWHERE);
    live.pageLoaded("https://other.example");
    expect(live.told(ELSEWHERE)).toBe(false);
    expect(live.told(A)).toBe(true);
  });

  test("that loads afresh, perhaps for another person, starts with nothing but Pause", async () => {
    fake.holder = A;
    live.view(A);
    live.begin(A, call());
    live.pause(B, true);
    fake.resolve?.();
    await settle();
    live.finished(A);
    live.pageLoaded(SERVER);
    expect(live.told(A)).toBe(false);
    expect(live.update(A)).toMatchObject({ live: false, frame: null });
    expect(live.update(B)?.paused).toBe(true);
  });

  test("sees no ring from an earlier spell or another app", async () => {
    live.begin(A, call());
    live.clicked(A, { x: 0.5, y: 0.5 });
    live.named(A, "TextEdit");
    expect(live.update(A)?.click).toBeNull();
    live.clicked(A, { x: 0.5, y: 0.5 });
    live.finished(A);
    await vi.advanceTimersByTimeAsync(20_000);
    live.begin(A, call());
    expect(live.update(A)?.click).toBeNull();
  });

  test("that reloads during a call keeps that call's spell going", () => {
    live.view(A);
    live.begin(A, call());
    live.pageLoaded(SERVER);
    expect(live.update(A)).toMatchObject({ live: true, busy: true });
  });

  test("hears a deleted chat end before it is forgotten", () => {
    const heard: (boolean | undefined)[] = [];
    live.view(A);
    live.begin(A, call());
    live.subscribe((chat) => heard.push(live.update(chat)?.live));
    live.forget(A);
    expect(heard).toEqual([false]);
    expect(live.update(A)).toBeNull();
    expect(live.told(A)).toBe(false);
  });

  test("brings a paused chat's view back with each refused call, even within its spell", () => {
    live.view(A);
    live.begin(A, call());
    live.finished(A);
    live.pause(A, true);
    const spell = live.update(A)!.spell;
    expect(live.begin(A, call())).toBe(false);
    // A new spell reopens its tab, even one the person closed.
    expect(live.update(A)?.spell).toBe(spell + 1);
  });
});
