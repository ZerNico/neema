import { randomUUID } from "node:crypto";
import { SeenFiles } from "./seen-files.ts";
import type { AgentAnswer } from "./dialogs.ts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createEgressProxy, type EgressProxy } from "@chat/egress-proxy";
import type { MachineEvent, MachineHello, ToolResult } from "@chat/desktop-rpc";
import { AgentRelay } from "./agent.ts";
import { dispatch } from "./dispatch.ts";
import { EgressPolicy } from "./egress.ts";
import type { Hypervisor } from "./hypervisor.ts";
import { MachineClient } from "./machine-client.ts";
import type { Mount } from "./paths.ts";
import { SentFiles } from "./sent-files.ts";
import { ChatVms, originLabel, type ChatKey } from "./vms.ts";
import { AppGrants } from "../app-use/grants.ts";
import { AppUse, type AppWatch, type SharedAppDriver } from "../app-use/host.ts";

export interface ComputerHostOptions {
  readonly origin: string;
  /** Where disks live: `<userData>/computer`. */
  readonly directory: string;
  readonly image: string;
  readonly hypervisor: Hypervisor;
  readonly machine: { readonly id: string; readonly name: string };
  /** A fetch carrying the desktop session's cookies for `origin`. */
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** The chat's workspace on the host, created when missing: the VM mounts it as /workspace. */
  readonly workspace: (conversationId: string) => Promise<string>;
  readonly folders: (conversationId: string) => Promise<readonly Mount[]>;
  /**
   * Whether a granted folder may still be mounted, asked each time a VM is made: one replaced
   * since by a link elsewhere (to credentials, say) is left out, as the strip shows it moved.
   */
  readonly stillMountable: (mount: Mount) => Promise<boolean>;
  readonly discardWorkspace: (conversationId: string) => Promise<void>;
  /** Chats of this server with something kept here: a workspace or an attached folder. */
  readonly localChats: () => Promise<readonly string[]>;
  /**
   * Copies a chat's workspace into its branch's (nothing when too large or already there), and
   * gives the branch the chat's folders.
   */
  readonly cloneWorkspace: (from: string, to: string) => Promise<void>;
  /** The SSH agent to relay to, looked up when a connection opens. */
  readonly agentSocket: () => string | null;
  /** Whether calls sent from the person's other devices may run here. */
  readonly remote: () => boolean;
  /** Native questions to the person at this machine; see `DispatchDeps`. */
  readonly ask: {
    folder(
      input: { path?: string; reason?: string },
      signal: AbortSignal,
    ): Promise<{ hostPath: string } | { refused: string }>;
    /** Says whether the agent holds a key too, which the model is told. */
    agent(input: { allowed: boolean }, signal: AbortSignal): Promise<AgentAnswer>;
    /** Whether a chat may use an app here; see docs/internals/app-use.md. */
    app(app: { name: string }, signal: AbortSignal): Promise<"chat" | "always" | "deny">;
    appPermissions(driver: SharedAppDriver, signal: AbortSignal): Promise<void>;
  };
  /** This desktop app's one app driver, shared with any later host; see `SharedAppDriver`. */
  readonly appDriver: SharedAppDriver;
  /** The person's live view of app use, shared like the driver. */
  readonly appWatch?: AppWatch;
  /** Attaches a folder to a chat here, refusing the ones no chat may have. */
  readonly attach: (
    conversationId: string,
    hostPath: string,
  ) => Promise<{ name: string } | { refused: string }>;
  readonly log: (message: string) => void;
}

type Status = MachineHello["computer"];

/** Results kept after their call ends, so a replayed call gets the answer instead of a rerun. */
const KEPT_MS = 10 * 60_000;

const fileName = (response: Response, fallback: string) => {
  const header = response.headers.get("content-disposition") ?? "";
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (utf8) {
    try {
      return decodeURIComponent(utf8[1]!);
    } catch {
      /* the plain name below */
    }
  }
  return /filename="([^"]*)"/i.exec(header)?.[1] || fallback;
};

/**
 * This machine's computer for one server: the VMs of that server's chats, the egress proxy and
 * agent relay they use, and the connection their calls arrive on. See docs/internals/desktop.md.
 */
/** How long quitting waits for the answers of the calls it stopped to reach the server. */
const QUIT_WAIT_MS = 2_000;

export class ComputerHost {
  private current: Status = { status: "preparing", progress: 0 };
  private readonly proxy: EgressProxy;
  private readonly policy: EgressPolicy;
  private readonly agent: AgentRelay;
  private readonly vms: ChatVms;
  private readonly client: MachineClient;
  private readonly sentFiles: SentFiles;
  private readonly seen = new SeenFiles();
  private readonly apps: AppUse;
  /**
   * Chats the server has shown exist while this app runs: it sent a call or event for them, or
   * saved their folders. A reconnect forgets only those it then calls gone, never a new chat's
   * draft, which has no row until its first message.
   */
  private readonly known = new Set<string>();
  /** Whether a sweep of every local chat, drafts left from earlier runs included, got an answer. */
  private swept = false;
  /** This app's start, told the server in every hello; see `MachineHello.launch`. */
  private readonly launch = randomUUID();
  private readonly calls = new Map<
    string,
    {
      abort: AbortController;
      result: Promise<ToolResult>;
      settled: boolean;
      /** The answer on its way to the server, so quitting can wait for it briefly. */
      posted?: Promise<void>;
    }
  >();

  constructor(private readonly options: ComputerHostOptions) {
    this.policy = new EgressPolicy((grantId) => this.proxy.regrant(grantId));
    this.proxy = createEgressProxy({
      decide: this.policy.decide,
      onDenial: this.policy.onDenial,
      local: this.policy.local,
      log: (_level, message) => options.log(message),
    });
    this.agent = new AgentRelay(options.agentSocket);
    this.sentFiles = new SentFiles(
      join(options.directory, `sent-files-${originLabel(options.origin)}.json`),
    );
    this.apps = new AppUse({
      driver: options.appDriver,
      scope: options.origin,
      grants: new AppGrants(
        join(options.directory, `app-grants-${originLabel(options.origin)}.json`),
      ),
      ask: (app, signal) => options.ask.app(app, signal),
      explainPermissions: (signal) => options.ask.appPermissions(options.appDriver, signal),
      log: options.log,
      ...(options.appWatch ? { watch: options.appWatch } : {}),
    });
    this.vms = new ChatVms({
      hypervisor: options.hypervisor,
      egress: this.proxy,
      image: options.image,
      disks: join(options.directory, "disks"),
      diskMib: 32 * 1024,
      cpus: 2,
      memoryMib: 2048,
      idleMs: 5 * 60_000,
      agentSocket: (key) => this.agent.socketFor(key),
      log: options.log,
    });
    this.client = new MachineClient({
      origin: options.origin,
      hello: () => this.hello(),
      fetch: options.fetch,
      onEvent: (event) => this.handle(event),
      // Until one sweep of every local chat got an answer, each connect tries it again; after,
      // a reconnect asks only about chats known to exist, so a draft is never taken for gone.
      // An unused chat deleted elsewhere while this machine was away waits for the next start.
      onConnected: (connected) => {
        if (connected)
          void this.forgetGone(this.swept ? this.known : undefined).catch((error: unknown) => {
            this.options.log(`computer: removing purged chats failed: ${String(error)}`);
          });
      },
      log: options.log,
    });
  }

  /** Whether chats' VMs can run here yet, as the server hears it. */
  status(): Status {
    return this.current;
  }

  hello(): MachineHello {
    return {
      machineId: this.options.machine.id,
      name: this.options.machine.name,
      platform:
        process.platform === "win32" || process.platform === "linux" ? process.platform : "darwin",
      computer: this.current,
      remote: this.options.remote(),
      apps: this.options.appDriver.executable !== null,
      launch: this.launch,
    };
  }

  /** Chats allowed the SSH agent are this machine's decision, so they are kept here. */
  private get agentFile() {
    return join(this.options.directory, `agent-chats-${originLabel(this.options.origin)}.json`);
  }

  private async saveAgentChats() {
    await writeFile(this.agentFile, JSON.stringify(this.agent.allowed(this.options.origin)));
  }

  /** Connects, then makes sure the image is here; the server hears each change of status. */
  async start() {
    await mkdir(this.options.directory, { recursive: true });
    const saved = await readFile(this.agentFile, "utf8")
      .then((text) => JSON.parse(text) as unknown)
      .catch(() => []);
    if (Array.isArray(saved))
      this.agent.setAllowed(
        this.options.origin,
        saved.filter((id): id is string => typeof id === "string"),
      );
    await this.proxy.listen();
    this.client.start();
    let reported = 0;
    try {
      await this.options.hypervisor.prepare(this.options.image, (fraction) => {
        this.current = { status: "preparing", progress: fraction };
        // A status per percent is plenty for a progress bar.
        if (fraction - reported >= 0.01) {
          reported = fraction;
          void this.client.postStatus();
        }
      });
      this.current = { status: "ready" };
    } catch (error) {
      this.current = {
        status: "unavailable",
        reason: error instanceof Error ? error.message : String(error),
      };
      this.options.log(`computer: this machine cannot run chat computers: ${this.current.reason}`);
    }
    await this.client.postStatus();
  }

  async stop() {
    const running = [...this.calls.values()].filter((call) => !call.settled);
    for (const call of running) call.abort.abort();
    // The "stopped" answers go out before the connection closes, so the model hears now that
    // they were cut off, not at their deadline; a couple of seconds at most, since this is quit.
    await Promise.race([
      Promise.all(running.map((call) => call.posted)),
      new Promise((resolve) => setTimeout(resolve, QUIT_WAIT_MS)),
    ]);
    await this.client.stop();
    await this.vms.stopAll();
    this.agent.close();
    await this.proxy.close();
  }

  private async mountable(conversationId: string) {
    const mounts = await this.options.folders(conversationId);
    const usable = await Promise.all(
      mounts.map((mount) => this.options.stillMountable(mount).catch(() => false)),
    );
    return mounts.filter((_, index) => usable[index]);
  }

  /** Tells the server the chat's folder names after an attach or detach here. */
  async foldersChanged(conversationId: string) {
    // Only what a VM would mount: a folder left out there is no folder for the model either.
    const mounts = await this.mountable(conversationId);
    const saved = await this.client.postFolders({
      conversationId,
      folders: mounts.map(({ name, readOnly }) => ({ name, readOnly })),
    });
    if (saved) this.known.add(conversationId);
  }

  /** Remote control was switched; the server hears it with the next hello. */
  remoteChanged() {
    void this.client.postStatus();
  }

  private key(conversationId: string): ChatKey {
    return { origin: this.options.origin, conversationId };
  }

  private handle(event: MachineEvent) {
    if ("conversationId" in event) this.known.add(event.conversationId);
    if (event.type === "clone") this.known.add(event.to);
    switch (event.type) {
      case "call": {
        const existing = this.calls.get(event.callId);
        if (existing) {
          // The same call again (a reconnect): answer with what it already gave or will give.
          void existing.result.then((result) =>
            this.client.postResult(event.callId, result, Date.now() + KEPT_MS),
          );
          return;
        }
        // The server's deadline, measured on this machine's clock from the time it took to arrive.
        const remainingMs = event.deadlineAt - event.sentAt;
        const deadline = Date.now() + remainingMs;
        const abort = new AbortController();
        // App use runs on this machine itself, never in the chat's VM.
        const result = event.name.startsWith("app_")
          ? this.apps.run({
              name: event.name,
              args: event.args,
              conversationId: event.conversationId,
              local: event.local === true,
              signal: abort.signal,
            })
          : dispatch(
              {
                vms: this.vms,
                egress: this.policy,
                sentFiles: this.sentFiles,
                seen: this.seen,
                setup: async (key) => ({
                  workspace: await this.options.workspace(key.conversationId),
                  mounts: await this.mountable(key.conversationId),
                }),
                attachment: (key, id, signal) => this.attachment(key, id, signal),
                agentAllowed: (key) => this.agent.isAllowed(key),
                // An answer after Stop, or past the deadline, grants nothing: the call is over.
                requestFolder: async (key, input, signal) => {
                  const chosen = await this.options.ask.folder(input, signal);
                  if (signal.aborted) return { refused: "The call was stopped before the answer." };
                  if ("refused" in chosen) return chosen;
                  const attached = await this.options.attach(key.conversationId, chosen.hostPath);
                  if ("name" in attached) await this.foldersChanged(key.conversationId);
                  return attached;
                },
                requestAgent: async (key, signal) => {
                  const allowed = this.agent.isAllowed(key);
                  const answer = await this.options.ask.agent({ allowed }, signal);
                  if (signal.aborted) return "declined";
                  if (answer !== "declined" && !allowed) {
                    this.agent.allow(key);
                    await this.saveAgentChats();
                  }
                  return answer;
                },
              },
              {
                callId: event.callId,
                key: this.key(event.conversationId),
                name: event.name,
                args: event.args,
                deadline,
                ...(event.attachments ? { attachments: event.attachments } : {}),
                signal: abort.signal,
              },
            );
        const entry: {
          abort: AbortController;
          result: Promise<ToolResult>;
          settled: boolean;
          posted?: Promise<void>;
        } = { abort, result, settled: false };
        this.calls.set(event.callId, entry);
        entry.posted = result.then(async (answer) => {
          entry.settled = true;
          await this.client.postResult(event.callId, answer, deadline);
          setTimeout(() => this.calls.delete(event.callId), KEPT_MS).unref();
        });
        return;
      }
      case "cancel":
        this.calls.get(event.callId)?.abort.abort();
        return;
      case "running": {
        const wanted = new Set(event.callIds);
        for (const [callId, call] of this.calls)
          if (!call.settled && !wanted.has(callId)) call.abort.abort();
        return;
      }
      case "grants":
        this.policy.setGrants(this.options.origin, event.grants);
        return;
      case "folders":
        void this.foldersChanged(event.conversationId).catch(() => {});
        return;
      case "clone":
        // The branch starts with no folder names on the server; it hears them from here, so it
        // never names a folder this machine does not mount.
        void this.options
          .cloneWorkspace(event.from, event.to)
          .then(() => this.foldersChanged(event.to))
          .catch((error: unknown) => {
            this.options.log(`computer: copying a branch's workspace failed: ${String(error)}`);
          });
        return;
      case "discard":
        void this.discardChat(event.conversationId, event.workspace);
        return;
    }
  }

  /** A chat is gone, or only its environment: its VM and disk go, and with the chat all it had. */
  private async discardChat(conversationId: string, everything: boolean) {
    const key = this.key(conversationId);
    try {
      await this.vms.discard(key);
      // A reset leaves the folders as they were, so what the model saw of them still holds.
      if (!everything) return;
      this.seen.forget(conversationId);
      await this.options.discardWorkspace(conversationId);
      await this.sentFiles.forget(conversationId);
      await this.apps.forgetChat(conversationId);
      if (this.agent.isAllowed(key)) {
        this.agent.forget(key);
        await this.saveAgentChats();
      }
    } catch (error) {
      this.options.log(`computer: discarding a chat failed: ${String(error)}`);
    }
  }

  /** Chats purged while this machine was offline missed their discard; it is done now. */
  private async forgetGone(only?: ReadonlySet<string>) {
    const local = new Set(
      [...(await this.options.localChats()), ...this.agent.allowed(this.options.origin)].filter(
        (id) => !only || only.has(id),
      ),
    );
    const gone = await this.client.gone([...local]);
    if (gone === null) return;
    if (!only) this.swept = true;
    for (const conversationId of gone) await this.discardChat(conversationId, true);
  }

  private async attachment(key: ChatKey, id: string, signal: AbortSignal) {
    const response = await this.options.fetch(`${key.origin}/api/files/${encodeURIComponent(id)}`, {
      signal,
    });
    if (!response.ok) return null;
    return {
      name: fileName(response, id),
      bytes: Buffer.from(await response.arrayBuffer()),
    };
  }
}
