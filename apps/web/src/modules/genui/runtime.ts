// Host side of one block's QuickJS runtime. Environment-agnostic: the
// browser Worker and the Node tests hand it a loaded QuickJS module. Only
// strings cross into and out of the VM; no host object or function is ever
// injected, which is the boundary docs/internals/generative-ui.md relies on.

import { shouldInterruptAfterDeadline, type QuickJSContext, type QuickJSRuntime, type QuickJSWASMModule } from "quickjs-emscripten-core";
import type { CompiledBlock } from "./compile.ts";
import { PRELUDE } from "./prelude.ts";

export const RUNTIME_LIMITS = {
  memoryBytes: 16 * 1024 * 1024,
  /** Below this the module traps on deep recursion instead of throwing. */
  stackBytes: 256 * 1024,
  scriptMs: 200,
  renderMs: 50,
  handlerMs: 200,
  treeChars: 256 * 1024,
  stateChars: 16 * 1024,
} as const;

export interface BlockAction {
  readonly kind: "send" | "open" | "copy";
  readonly value: string;
}

export type RenderOutcome =
  | { readonly ok: true; readonly rev: number; readonly nodes: unknown[] }
  | { readonly ok: false; readonly error: string };

export type CallOutcome =
  | { readonly ok: true; readonly actions: BlockAction[]; readonly error: string | null }
  | { readonly ok: false; readonly stale: true }
  | { readonly ok: false; readonly stale: false; readonly error: string };

export type BootOutcome =
  | { readonly ok: true; readonly runtime: BlockRuntime }
  | { readonly ok: false; readonly error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isAction(value: unknown): value is BlockAction {
  return (
    isRecord(value) &&
    (value.kind === "send" || value.kind === "open" || value.kind === "copy") &&
    typeof value.value === "string"
  );
}

export class BlockRuntime {
  private disposed = false;

  private constructor(
    private readonly runtime: QuickJSRuntime,
    private readonly context: QuickJSContext,
  ) {}

  /**
   * Runs the prelude and the block's script. `saved` is the state JSON from
   * an earlier session; `now` freezes the block's clock (the message's
   * creation time, so reload and branch see the same tree).
   */
  static boot(module: QuickJSWASMModule, block: CompiledBlock, saved: string | null, now: number): BootOutcome {
    const runtime = module.newRuntime();
    runtime.setMemoryLimit(RUNTIME_LIMITS.memoryBytes);
    runtime.setMaxStackSize(RUNTIME_LIMITS.stackBytes);
    const context = runtime.newContext();
    const instance = new BlockRuntime(runtime, context);
    const prelude = instance.evaluate(PRELUDE, RUNTIME_LIMITS.scriptMs);
    if (!prelude.ok) {
      instance.dispose();
      return { ok: false, error: `prelude: ${prelude.error}` };
    }
    const savedArg = saved === null ? "null" : JSON.stringify(saved);
    const boot = instance.evaluate(
      `__host.boot(${savedArg}, ${JSON.stringify(now)}, ${block.source})`,
      RUNTIME_LIMITS.scriptMs,
    );
    if (!boot.ok) {
      instance.dispose();
      return { ok: false, error: boot.error };
    }
    return { ok: true, runtime: instance };
  }

  private evaluate(code: string, ms: number): { ok: true; value: unknown } | { ok: false; error: string } {
    if (this.disposed) return { ok: false, error: "disposed" };
    this.runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + ms));
    const result = this.context.evalCode(code, "block.js", { type: "global" });
    if (result.error) {
      const dumped: unknown = this.context.dump(result.error);
      result.error.dispose();
      const message = isRecord(dumped) && typeof dumped.message === "string" ? dumped.message : String(dumped);
      return { ok: false, error: message };
    }
    const value: unknown = this.context.dump(result.value);
    result.value.dispose();
    return { ok: true, value };
  }

  render(): RenderOutcome {
    const result = this.evaluate("__host.render()", RUNTIME_LIMITS.renderMs);
    if (!result.ok) return result;
    if (typeof result.value !== "string") return { ok: false, error: "render_returned_non_string" };
    // Check the size before parsing: the host must not parse an unbounded string.
    if (result.value.length > RUNTIME_LIMITS.treeChars) return { ok: false, error: "tree_too_large" };
    const parsed = parseJson(result.value);
    if (!isRecord(parsed) || typeof parsed.rev !== "number") return { ok: false, error: "render_malformed" };
    if (typeof parsed.error === "string") return { ok: false, error: parsed.error };
    if (!Array.isArray(parsed.nodes)) return { ok: false, error: "render_malformed" };
    return { ok: true, rev: parsed.rev, nodes: parsed.nodes };
  }

  /** Runs handler `id` from render `rev`; a handler from an older render is refused. */
  call(rev: number, id: number, args: readonly unknown[]): CallOutcome {
    if (!Number.isSafeInteger(rev) || !Number.isSafeInteger(id)) return { ok: false, stale: false, error: "bad_handler" };
    const argsJson = JSON.stringify(args);
    if (argsJson.length > RUNTIME_LIMITS.stateChars) return { ok: false, stale: false, error: "args_too_large" };
    const result = this.evaluate(
      `__host.call(${rev}, ${id}, ${JSON.stringify(argsJson)})`,
      RUNTIME_LIMITS.handlerMs,
    );
    if (!result.ok) return { ok: false, stale: false, error: result.error };
    const parsed = typeof result.value === "string" ? parseJson(result.value) : null;
    if (!isRecord(parsed)) return { ok: false, stale: false, error: "call_malformed" };
    if (parsed.stale === true) return { ok: false, stale: true };
    const actions = Array.isArray(parsed.actions) ? parsed.actions.filter(isAction).slice(0, 1) : [];
    return { ok: true, actions, error: typeof parsed.error === "string" ? parsed.error : null };
  }

  /** The block's persisted state as JSON, or null when it outgrew the cap. */
  state(): string | null {
    const result = this.evaluate("__host.state()", RUNTIME_LIMITS.renderMs);
    if (!result.ok || typeof result.value !== "string") return null;
    return result.value.length > RUNTIME_LIMITS.stateChars ? null : result.value;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.context.dispose();
    this.runtime.dispose();
  }
}
