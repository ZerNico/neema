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
import { ChatVms, originLabel, type ChatKey } from "./vms.ts";

export interface ComputerHostOptions {
  readonly origin: string;
  /** Where disks live: `<userData>/computer`. */
  readonly directory: string;
  readonly image: string;
  readonly hypervisor: Hypervisor;
  readonly machine: { readonly id: string; readonly name: string };
  /** A fetch carrying the desktop session's cookies for `origin`. */
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>;
  readonly workspace: (conversationId: string) => string;
  readonly folders: (conversationId: string) => Promise<readonly Mount[]>;
  readonly discardWorkspace: (conversationId: string) => Promise<void>;
  /** The SSH agent to relay to, looked up when a connection opens. */
  readonly agentSocket: () => string | null;
  /** Whether calls sent from the person's other devices may run here. */
  readonly remote: () => boolean;
  /** Native questions to the person at this machine; see `DispatchDeps`. */
  readonly ask: {
    folder(input: {
      path?: string;
      reason?: string;
    }): Promise<{ hostPath: string } | { refused: string }>;
    agent(): Promise<boolean>;
  };
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
export class ComputerHost {
  private current: Status = { status: "preparing", progress: 0 };
  private readonly proxy: EgressProxy;
  private readonly policy: EgressPolicy;
  private readonly agent: AgentRelay;
  private readonly vms: ChatVms;
  private readonly client: MachineClient;
  private readonly calls = new Map<
    string,
    { abort: AbortController; result: Promise<ToolResult> }
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
    for (const call of this.calls.values()) call.abort.abort();
    await this.client.stop();
    await this.vms.stopAll();
    this.agent.close();
    await this.proxy.close();
  }

  /** Tells the server the chat's folder names after an attach or detach here. */
  async foldersChanged(conversationId: string) {
    const mounts = await this.options.folders(conversationId);
    await this.client.postFolders({
      conversationId,
      folders: mounts.map(({ name, readOnly }) => ({ name, readOnly })),
    });
  }

  /** Remote control was switched; the server hears it with the next hello. */
  remoteChanged() {
    void this.client.postStatus();
  }

  private key(conversationId: string): ChatKey {
    return { origin: this.options.origin, conversationId };
  }

  private handle(event: MachineEvent) {
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
        const result = dispatch(
          {
            vms: this.vms,
            egress: this.policy,
            setup: async (key) => ({
              workspace: this.options.workspace(key.conversationId),
              mounts: await this.options.folders(key.conversationId),
            }),
            attachment: (key, id) => this.attachment(key, id),
            agentAllowed: (key) => this.agent.isAllowed(key),
            requestFolder: async (key, input) => {
              const chosen = await this.options.ask.folder(input);
              if ("refused" in chosen) return chosen;
              const attached = await this.options.attach(key.conversationId, chosen.hostPath);
              if ("name" in attached) await this.foldersChanged(key.conversationId);
              return attached;
            },
            requestAgent: async (key) => {
              if (this.agent.isAllowed(key)) return true;
              if (!(await this.options.ask.agent())) return false;
              this.agent.allow(key);
              await this.saveAgentChats();
              return true;
            },
          },
          {
            callId: event.callId,
            key: this.key(event.conversationId),
            name: event.name,
            args: event.args,
            remainingMs,
            ...(event.attachments ? { attachments: event.attachments } : {}),
            signal: abort.signal,
          },
        );
        this.calls.set(event.callId, { abort, result });
        void result.then(async (answer) => {
          await this.client.postResult(event.callId, answer, deadline);
          setTimeout(() => this.calls.delete(event.callId), KEPT_MS).unref();
        });
        return;
      }
      case "cancel":
        this.calls.get(event.callId)?.abort.abort();
        return;
      case "grants":
        this.policy.setGrants(this.options.origin, event.grants);
        return;
      case "discard":
        void this.vms
          .discard(this.key(event.conversationId))
          .then(() =>
            event.workspace ? this.options.discardWorkspace(event.conversationId) : undefined,
          );
        return;
    }
  }

  private async attachment(key: ChatKey, id: string) {
    const response = await this.options.fetch(`${key.origin}/api/files/${encodeURIComponent(id)}`);
    if (!response.ok) return null;
    return {
      name: fileName(response, id),
      bytes: Buffer.from(await response.arrayBuffer()),
    };
  }
}
