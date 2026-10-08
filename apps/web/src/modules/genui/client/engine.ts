// What the Worker does with a block, kept free of Worker APIs so tests run it
// in Node with the same QuickJS build. Parsing, compiling, evaluation and
// catalog validation all happen here, off the main thread: the page only
// receives trees that already passed the catalog.

import type { QuickJSWASMModule } from "quickjs-emscripten-core";
import { validateTree, type TreeDiagnostic, type ValidNode } from "../catalog.ts";
import { compileUi } from "../compile.ts";
import { hashSource } from "../fences.ts";
import type { Diagnostic } from "../parse.ts";
import { BlockRuntime, type BlockAction } from "../runtime.ts";

/** Runtimes kept alive at once; the least recently used one is disposed. */
export const MAX_LIVE_BLOCKS = 16;

export interface RenderRequest {
  readonly block: string;
  readonly code: string;
  /** State to start from when the block has no live runtime. */
  readonly saved: string | null;
  readonly now: number;
}

export interface CallRequest {
  readonly block: string;
  /** The `source` of the render the handler came from. */
  readonly source: string;
  readonly rev: number;
  readonly handler: number;
  readonly args: readonly unknown[];
}

export type RenderReply =
  | {
      readonly ok: true;
      /**
       * Hash of the source this runtime was built from. Revisions restart with
       * each runtime, so a handler is only the one drawn if this matches too.
       */
      readonly source: string;
      readonly rev: number;
      readonly nodes: (ValidNode | string)[];
      readonly state: string | null;
      readonly diagnostics: (Diagnostic | TreeDiagnostic)[];
    }
  | {
      readonly ok: false;
      /** `incomplete`: wait for more source. `rejected`: show the source. */
      readonly reason: "incomplete" | "rejected" | "failed";
      readonly error?: string;
      readonly diagnostics: (Diagnostic | TreeDiagnostic)[];
    };

export type CallReply =
  | {
      readonly ok: true;
      readonly actions: BlockAction[];
      readonly error: string | null;
      readonly render: RenderReply;
    }
  | { readonly ok: false; readonly stale: true }
  | { readonly ok: false; readonly stale: false; readonly error: string };

interface Live {
  readonly hash: string;
  readonly runtime: BlockRuntime;
  readonly diagnostics: Diagnostic[];
}

export class BlockEngine {
  private readonly live = new Map<string, Live>();

  constructor(private readonly module: QuickJSWASMModule) {}

  render(request: RenderRequest): RenderReply {
    const hash = hashSource(request.code);
    let entry = this.touch(request.block);
    if (!entry || entry.hash !== hash) {
      // Source changed (still streaming, or a retry): carry the live state over,
      // so a block being written does not reset what the reader already set.
      const carried = entry?.runtime.state() ?? request.saved;
      if (entry) this.release(request.block);
      const compiled = compileUi(request.code);
      if (!compiled.ok) {
        return {
          ok: false,
          reason: compiled.incomplete ? "incomplete" : "rejected",
          diagnostics: compiled.diagnostics,
        };
      }
      const booted = BlockRuntime.boot(this.module, compiled.block, carried, request.now);
      if (!booted.ok)
        return {
          ok: false,
          reason: "failed",
          error: booted.error,
          diagnostics: compiled.block.diagnostics,
        };
      entry = { hash, runtime: booted.runtime, diagnostics: compiled.block.diagnostics };
      this.live.set(request.block, entry);
      this.evict();
    }
    return this.renderLive(entry);
  }

  call(request: CallRequest): CallReply {
    const entry = this.touch(request.block);
    if (!entry || entry.hash !== request.source) return { ok: false, stale: true };
    const result = entry.runtime.call(request.rev, request.handler, request.args);
    if (!result.ok) return result;
    return {
      ok: true,
      actions: result.actions,
      error: result.error,
      render: this.renderLive(entry),
    };
  }

  release(block: string): void {
    this.live.get(block)?.runtime.dispose();
    this.live.delete(block);
  }

  private renderLive(entry: Live): RenderReply {
    const out = entry.runtime.render();
    if (!out.ok)
      return { ok: false, reason: "failed", error: out.error, diagnostics: entry.diagnostics };
    let tree: ReturnType<typeof validateTree>;
    try {
      tree = validateTree(out.nodes);
    } catch (error) {
      // A host bug on one block's tree costs that block, not the Worker every block shares.
      return {
        ok: false,
        reason: "failed",
        error: error instanceof Error ? error.message : String(error),
        diagnostics: entry.diagnostics,
      };
    }
    return {
      ok: true,
      source: entry.hash,
      rev: out.rev,
      nodes: tree.nodes,
      state: entry.runtime.state(),
      diagnostics: [...entry.diagnostics, ...tree.diagnostics],
    };
  }

  private touch(block: string): Live | undefined {
    const entry = this.live.get(block);
    if (entry) {
      this.live.delete(block);
      this.live.set(block, entry);
    }
    return entry;
  }

  private evict(): void {
    while (this.live.size > MAX_LIVE_BLOCKS) {
      const oldest = this.live.keys().next().value;
      if (oldest === undefined) return;
      this.release(oldest);
    }
  }
}
