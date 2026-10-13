import { isIP, type Socket } from "node:net";
import type { GrantDecision, ProxyOptions } from "./index.ts";
import { interfaceIdentities, preparedRefusal } from "./address-guard.ts";
import { type Identity, Tokens } from "./auth.ts";
import { canonicalHost, parseTarget, plainHttpAuthority } from "./host.ts";
import { RequestParser, type RequestHead } from "./parser.ts";
import { Deadline, type Timers } from "./timers.ts";

type Candidate = { address: string; family: 4 | 6 };
type Target = { host: string; port: number; kind: "name" | "ipv4" | "ipv6" };
export type Limits = Required<NonNullable<ProxyOptions["limits"]>>;

export interface Services {
  readonly options: ProxyOptions;
  readonly tokens: Tokens;
  readonly timers: Timers;
  readonly limits: Limits;
  readonly connections: Set<Connection>;
  readonly resolve: (
    host: string,
    signal: AbortSignal,
  ) => ReturnType<NonNullable<ProxyOptions["resolve"]>>;
  readonly interfaceAddresses: NonNullable<ProxyOptions["interfaceAddresses"]>;
  readonly connect: NonNullable<ProxyOptions["connect"]>;
  readonly log: NonNullable<ProxyOptions["log"]>;
  earlyBytes: number;
  preTunnelConnections: number;
  reservedTunnels: number;
  outstandingResolutions: number;
}

const responses = {
  400: "Bad Request",
  403: "Forbidden",
  407: "Proxy Authentication Required",
  431: "Request Header Fields Too Large",
  500: "Internal Server Error",
  502: "Bad Gateway",
} as const;
type Status = keyof typeof responses;

type Allowed = Extract<GrantDecision, { allowed: true }>;

// The type requires a grant id; a blank one would still make the tunnel unrevocable.
function checkedDecision(decision: GrantDecision): GrantDecision {
  const snapshot = { ...decision };
  if (snapshot.allowed && (typeof snapshot.grantId !== "string" || !snapshot.grantId.trim())) {
    throw new Error("Allowed decision requires a grant id");
  }
  return snapshot;
}

export class Connection {
  identity: Identity | undefined;
  reserved = false;
  /**
   * headers: parse or abandon; establishing: buffer, resolve, dial, regrant or abandon.
   * responding: flush or backstop; tunnel: relay, half-close or revoke; closed: ignore.
   * Errors stop any phase. Late DNS only releases its budget; late dials are destroyed.
   */
  private phase: "headers" | "establishing" | "responding" | "tunnel" | "closed" = "headers";
  private preTunnel = true;
  private parser: RequestParser | undefined = new RequestParser();
  private target: Target | undefined;
  private decision: Allowed | undefined;
  private upstream: Socket | undefined;
  private selected: Candidate | undefined;
  private readonly fallbackRefusals = new Set<string>();
  private resolutionAbort: AbortController | undefined;
  private early: Buffer[] = [];
  private earlyBytes = 0;
  private readonly deadline: Deadline;
  private readonly idle: Deadline;
  private readonly backstop: Deadline;

  constructor(
    private readonly client: Socket,
    private readonly services: Services,
    /** Set on a command's own listener, where the port is the credential. */
    private readonly preset?: Identity,
  ) {
    this.deadline = new Deadline(services.timers);
    this.idle = new Deadline(services.timers);
    this.backstop = new Deadline(services.timers);
    client.on("data", (chunk: Buffer) => this.receive(chunk));
    client.on("error", () => this.stop());
    client.on("end", () => {
      if (this.phase === "headers" || this.phase === "establishing") this.stop();
    });
    client.on("close", () => {
      if (this.phase === "tunnel" && client.readableEnded && client.writableFinished) {
        this.finishRelay();
      } else this.stop();
    });
    this.deadline.start(services.limits.headerMs, () => this.respond(400, "Incomplete request"));
  }

  snapshot() {
    if (this.phase !== "tunnel" || !this.identity || !this.target) return;
    return {
      context: this.identity.context,
      host: this.target.host,
      port: this.target.port,
      ...(this.decision?.grantId === undefined ? {} : { grantId: this.decision.grantId }),
    };
  }

  regrant(grantId: string) {
    if (!this.reserved || this.decision?.grantId !== grantId || !this.identity || !this.target)
      return;
    try {
      const next = checkedDecision(
        this.services.options.decide(this.identity.context, this.target.host, this.target.port),
      );
      if (!this.reserved || !this.identity.active) return;
      let reason = next.allowed ? undefined : (next.reason ?? "Grant removed");
      if (next.allowed) {
        const interfaces = interfaceIdentities(this.services.interfaceAddresses());
        if (this.selected) {
          const refusal = preparedRefusal(
            this.selected.address,
            interfaces,
            next.privateNetwork === true,
          );
          if (refusal) reason = `Address policy refused: ${refusal}`;
        }
      }
      if (!next.allowed || reason !== undefined) {
        if (this.phase === "tunnel") this.stop();
        else this.deny(reason ?? "Grant removed");
        return;
      }
      this.decision = next;
    } catch {
      this.fault();
    }
  }

  stop() {
    if (this.phase === "closed") return;
    this.phase = "closed";
    this.release();
    this.releasePreTunnel();
    this.backstop.clear();
    this.parser = undefined;
    this.upstream?.destroy();
    this.client.destroy();
    this.services.connections.delete(this);
  }

  private releasePreTunnel() {
    if (!this.preTunnel) return;
    this.preTunnel = false;
    this.services.preTunnelConnections--;
  }

  private finishRelay() {
    if (this.client.destroyed && this.upstream?.destroyed) this.stop();
  }

  private releaseEarly() {
    this.services.earlyBytes -= this.earlyBytes;
    this.earlyBytes = 0;
    this.early = [];
  }

  private release() {
    this.resolutionAbort?.abort();
    if (this.reserved && this.identity) {
      this.reserved = false;
      this.services.reservedTunnels--;
      this.identity.reservedTunnels--;
    }
    this.deadline.clear();
    this.idle.clear();
    this.releaseEarly();
  }

  private receive(chunk: Buffer) {
    if (this.phase === "tunnel") {
      this.touch();
    } else if (this.phase === "establishing") {
      this.bufferEarly(chunk);
    } else if (this.phase === "headers") {
      const parsed = this.parser?.feed(chunk);
      if (!parsed) return;
      this.parser = undefined;
      if ("error" in parsed) this.respond(parsed.error, responses[parsed.error]);
      else this.accept(parsed.request);
    }
  }

  private bufferEarly(chunk: Buffer) {
    if (!chunk.length) return;
    if (
      this.earlyBytes + chunk.length > this.services.limits.earlyBytes ||
      this.services.earlyBytes + chunk.length > this.services.limits.earlyBytesTotal
    ) {
      this.stop();
      return;
    }
    this.early.push(Buffer.from(chunk));
    this.earlyBytes += chunk.length;
    this.services.earlyBytes += chunk.length;
  }

  private accept(request: RequestHead) {
    this.identity = this.preset
      ? this.preset.active
        ? this.preset
        : undefined
      : this.services.tokens.authenticate(request.headers);
    if (!this.identity) {
      this.respond(407, "Proxy authentication required");
      return;
    }
    if (request.method !== "CONNECT") {
      const authority = plainHttpAuthority(request.target);
      this.deny(
        "Plain HTTP is not supported. Use CONNECT.",
        authority?.host ?? "",
        authority?.port ?? 0,
        request.method === "HEAD",
      );
      return;
    }
    const target = parseTarget(request.target);
    if (!target) {
      this.respond(400, "Invalid CONNECT target");
      return;
    }
    const canonical = canonicalHost(target.host);
    if (!canonical.ok) {
      this.deny(canonical.reason, "", target.port);
      return;
    }
    this.target = { host: canonical.host, port: target.port, kind: canonical.kind };
    let decision: GrantDecision;
    try {
      decision = checkedDecision(
        this.services.options.decide(this.identity.context, canonical.host, target.port),
      );
    } catch {
      this.fault();
      return;
    }
    if (this.phase !== "headers" || !this.identity.active || this.client.destroyed) return;
    if (!decision.allowed) {
      this.deny(decision.reason ?? "No grant for host:port");
      return;
    }
    this.decision = decision;
    if (
      this.services.reservedTunnels >= this.services.limits.tunnelsTotal ||
      this.identity.reservedTunnels >= this.services.limits.tunnelsPerToken
    ) {
      this.deny("Concurrent tunnel limit exceeded");
      return;
    }
    this.phase = "establishing";
    this.reserved = true;
    this.services.reservedTunnels++;
    this.identity.reservedTunnels++;
    this.deadline.start(this.services.limits.establishMs, () =>
      this.network("Establishment deadline exceeded"),
    );
    this.bufferEarly(request.early);
    if (this.pending()) void this.resolve();
  }

  private pending() {
    return (
      this.phase === "establishing" && this.identity?.active === true && !this.client.destroyed
    );
  }

  private async resolve() {
    const target = this.target;
    const identity = this.identity;
    if (!target || !identity) return;
    let answers: ReadonlyArray<Candidate>;
    if (target.kind === "name") {
      if (
        identity.outstandingResolutions >= this.services.limits.outstandingResolutionsPerToken ||
        this.services.outstandingResolutions >= this.services.limits.outstandingResolutionsTotal
      ) {
        this.deny("Outstanding resolution limit exceeded");
        return;
      }
      identity.outstandingResolutions++;
      this.services.outstandingResolutions++;
      this.resolutionAbort = new AbortController();
      try {
        answers = await this.services.resolve(target.host, this.resolutionAbort.signal);
      } catch {
        if (this.pending()) this.network("DNS resolution failed");
        return;
      } finally {
        // Default cancellation settles promptly. Injected work still owns its slot until settlement.
        this.resolutionAbort = undefined;
        identity.outstandingResolutions--;
        this.services.outstandingResolutions--;
      }
    } else {
      answers = [{ address: target.host, family: target.kind === "ipv4" ? 4 : 6 }];
    }
    if (!this.pending()) return;
    try {
      if (!Array.isArray(answers)) throw new Error("Invalid resolver result");
      if (answers.length === 0) {
        this.network("DNS returned no addresses");
        return;
      }
      const interfaces = interfaceIdentities(this.services.interfaceAddresses());
      const survivors: Candidate[] = [];
      const refused = new Set<string>();
      for (const answer of answers) {
        if (
          !answer ||
          typeof answer !== "object" ||
          typeof answer.address !== "string" ||
          (answer.family !== 4 && answer.family !== 6)
        )
          throw new Error("Invalid resolver entry");
        const canonical = canonicalHost(answer.address);
        const valid =
          isIP(answer.address) === answer.family && canonical.ok && canonical.kind !== "name";
        const reason = valid
          ? preparedRefusal(answer.address, interfaces, this.decision?.privateNetwork === true)
          : "invalid address";
        if (reason) {
          refused.add(reason);
          // Only validated numeric addresses may enter diagnostics, never DNS text or errors.
          this.services.log(
            "warn",
            `Egress proxy: refused address ${valid ? canonical.host : "invalid"}: ${reason}`,
          );
        } else if (canonical.ok && canonical.kind !== "name") {
          survivors.push({ address: canonical.host, family: canonical.kind === "ipv4" ? 4 : 6 });
        }
      }
      if (!survivors.length)
        this.deny(`Address policy refused: ${[...refused].toSorted().join(", ")}`);
      else this.dial(survivors, 0);
    } catch {
      if (this.pending()) this.fault();
    }
  }

  private dial(candidates: readonly Candidate[], index: number) {
    if (!this.pending() || !this.target) return;
    const candidate = candidates[index];
    if (!candidate) {
      // Exhausted fallback is 403 if any candidate was policy-refused, regardless of order.
      // Return 502 only when every fallback candidate failed at the network level.
      if (this.fallbackRefusals.size)
        this.deny(`Address policy refused: ${[...this.fallbackRefusals].toSorted().join(", ")}`);
      else this.network("Upstream connection failed");
      return;
    }
    let refusal: string | null;
    try {
      const interfaces = interfaceIdentities(this.services.interfaceAddresses());
      refusal = preparedRefusal(
        candidate.address,
        interfaces,
        this.decision?.privateNetwork === true,
      );
    } catch {
      this.fault();
      return;
    }
    if (!this.pending()) return;
    if (refusal) {
      this.fallbackRefusals.add(refusal);
      queueMicrotask(() => this.dial(candidates, index + 1));
      return;
    }
    this.selected = candidate;
    let socket: Socket;
    try {
      socket = this.services.connect(candidate.address, this.target.port, candidate.family);
    } catch {
      this.selected = undefined;
      this.services.log("warn", "Egress proxy: upstream connection failed");
      queueMicrotask(() => this.dial(candidates, index + 1));
      return;
    }
    this.upstream = socket;
    let failed = false;
    const fail = () => {
      if (failed) return;
      failed = true;
      socket.destroy();
      if (this.phase === "tunnel" && this.upstream === socket) {
        this.services.log("warn", "Egress proxy: tunnel transport failed");
        this.stop();
      } else if (this.pending() && this.upstream === socket) {
        this.selected = undefined;
        this.services.log("warn", "Egress proxy: upstream connection failed");
        this.upstream = undefined;
        this.dial(candidates, index + 1);
      }
    };
    socket.on("error", fail);
    socket.on("close", () => {
      if (
        this.phase === "tunnel" &&
        this.upstream === socket &&
        socket.readableEnded &&
        socket.writableFinished
      ) {
        this.finishRelay();
      } else fail();
    });
    socket.once("connect", () => {
      if (!this.pending() || this.upstream !== socket || socket.destroyed) {
        socket.destroy();
        return;
      }
      this.establish(socket);
    });
    if (!this.pending()) socket.destroy();
  }

  private establish(socket: Socket) {
    this.client.pause();
    this.phase = "tunnel";
    this.releasePreTunnel();
    this.deadline.clear();
    const early = Buffer.concat(this.early, this.earlyBytes);
    this.releaseEarly();
    this.touch();
    this.client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    socket.on("data", () => this.touch());
    socket.pipe(this.client);
    const relay = () => {
      if (this.phase === "tunnel") this.client.pipe(socket);
    };
    if (early.length && !socket.write(early)) socket.once("drain", relay);
    else relay();
  }

  private touch() {
    if (this.phase === "tunnel") this.idle.start(this.services.limits.idleMs, () => this.stop());
  }

  private deny(
    reason: string,
    host = this.target?.host ?? "",
    port = this.target?.port ?? 0,
    headOnly = false,
  ) {
    if (!this.identity || this.phase === "closed" || this.phase === "responding") return;
    this.respond(403, reason, headOnly);
    try {
      this.services.options.onDenial({ context: this.identity.context, host, port, reason });
    } catch {
      this.services.log("error", "Egress proxy: denial reporting failed");
    }
  }

  private network(reason: string) {
    this.services.log("warn", `Egress proxy: ${reason}`);
    this.respond(502, reason);
  }

  private fault() {
    this.services.log("error", "Egress proxy: internal fault");
    if (this.phase === "tunnel") this.stop();
    else this.respond(500, "Internal proxy fault");
  }

  private respond(status: Status, body: string, headOnly = false) {
    if (this.phase === "closed" || this.phase === "responding" || this.phase === "tunnel") return;
    if (this.client.destroyed) {
      this.stop();
      return;
    }
    // EOF during a queued denial must not run the pre-establishment abandonment path.
    this.phase = "responding";
    this.release();
    this.parser = undefined;
    this.upstream?.destroy();
    const headers = [
      `HTTP/1.1 ${status} ${responses[status]}`,
      "Connection: close",
      "Content-Type: text/plain; charset=utf-8",
      `Content-Length: ${Buffer.byteLength(body)}`,
    ];
    if (status === 407) headers.push('Proxy-Authenticate: Basic realm="egress"');
    if (status === 403) headers.push("x-egress-denied: 1");
    this.backstop.start(this.services.limits.responseCloseMs, () => this.stop());
    this.client.end(`${headers.join("\r\n")}\r\n\r\n${headOnly ? "" : body}`, () => this.stop());
  }
}
