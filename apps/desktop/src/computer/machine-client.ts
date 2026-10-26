import { Schema } from "effect";
import {
  MACHINE_HELLO_HEADER,
  MACHINE_ROUTES,
  MachineEvent,
  type MachineFolders,
  type MachineHello,
  type ToolResult,
} from "@chat/desktop-rpc";

const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(MachineEvent));

export interface MachineClientOptions {
  readonly origin: string;
  /** The hello as it is now: sent with every request, so the server always knows the latest. */
  readonly hello: () => MachineHello;
  /** A fetch carrying the desktop session's cookies. */
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>;
  readonly onEvent: (event: MachineEvent) => void;
  readonly onConnected?: (connected: boolean) => void;
  readonly log?: (message: string) => void;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });

/**
 * The machine's side of the server connection: one event stream held open for as long as the app
 * runs, reconnecting with backoff, and plain POSTs for results, folder names and a new hello. It
 * runs in the main process, so a closed or reloading window changes nothing.
 */
export class MachineClient {
  private readonly stopping = new AbortController();
  private running: Promise<void> | undefined;

  constructor(private readonly options: MachineClientOptions) {}

  start() {
    this.running ??= this.loop();
  }

  async stop() {
    this.stopping.abort();
    await this.running;
  }

  /**
   * Delivers a result, retrying on network failure until the server answers or the call's
   * deadline passes; a refusal is final (the call ended meanwhile).
   */
  async postResult(callId: string, result: ToolResult, deadline: number) {
    for (let delay = 500; Date.now() < deadline && !this.stopping.signal.aborted; delay *= 2) {
      try {
        const response = await this.post(MACHINE_ROUTES.result(callId), result);
        if (response.status < 500) return;
      } catch {
        // Unreachable server: retried below until the deadline.
      }
      await sleep(
        Math.min(delay, 10_000, Math.max(0, deadline - Date.now())),
        this.stopping.signal,
      );
    }
  }

  async postFolders(folders: MachineFolders) {
    await this.post(MACHINE_ROUTES.folders, folders).catch(() => {});
  }

  async postStatus() {
    await this.post(MACHINE_ROUTES.status, {}).catch(() => {});
  }

  private headers(): Record<string, string> {
    return { [MACHINE_HELLO_HEADER]: JSON.stringify(this.options.hello()) };
  }

  private post(route: string, body: unknown) {
    return this.options.fetch(`${this.options.origin}${route}`, {
      method: "POST",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private async loop() {
    const signal = this.stopping.signal;
    let backoff = 1_000;
    while (!signal.aborted) {
      try {
        const response = await this.options.fetch(
          `${this.options.origin}${MACHINE_ROUTES.events}`,
          {
            headers: { ...this.headers(), accept: "text/event-stream" },
            signal,
          },
        );
        if (response.status === 401) {
          // Signed out, or a browser session: nothing changes until the person signs in again.
          this.options.log?.("computer: the server refused this machine's session");
          await sleep(60_000, signal);
          continue;
        }
        if (!response.ok || !response.body) throw new Error(`events answered ${response.status}`);
        this.options.onConnected?.(true);
        backoff = 1_000;
        await this.read(response.body);
      } catch (error) {
        if (signal.aborted) break;
        this.options.log?.(`computer: event stream failed: ${String(error)}`);
      }
      this.options.onConnected?.(false);
      await sleep(backoff, signal);
      backoff = Math.min(backoff * 2, 30_000);
    }
  }

  private async read(body: ReadableStream<Uint8Array>) {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of body) {
      buffer += decoder.decode(chunk, { stream: true });
      for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .join("\n");
        if (!data) continue;
        const event = decodeEvent(data);
        if (event._tag === "Some") this.options.onEvent(event.value);
        else this.options.log?.("computer: ignored an event it could not read");
      }
    }
  }
}
