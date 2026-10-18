import type {
  CallToolResult,
  InputRequiredResult,
  McpServer,
  RequestStateCodec,
  ServerContext,
  ToolAnnotations,
} from "@modelcontextprotocol/server";
import { Data, Effect, Schema } from "effect";
import type { McpScope } from "../../scopes.ts";
import type { McpPrincipal } from "../auth.ts";
import type { TurnRequestState } from "../request-state.ts";
import { toolInput } from "./input.ts";

/** A refusal the app explains to the calling model, in words it can act on. */
export class McpToolError extends Data.TaggedError("McpToolError")<{ readonly message: string }> {}

export interface McpToolContext {
  readonly principal: McpPrincipal;
  /** The public origin, for links back into the app. */
  readonly origin: string;
  /** Aborted when the client gives up on the request. */
  readonly signal: AbortSignal;
  readonly server: ServerContext;
  /** Seals the turn a call stops to ask about, for the call that comes back. */
  readonly turnState: RequestStateCodec<TurnRequestState>;
}

export type McpToolResult = CallToolResult | InputRequiredResult;

/** Runs a tool's effect where its services live; production passes the app runtime. */
export type McpRun<R> = <A>(effect: Effect.Effect<A, never, R>, signal: AbortSignal) => Promise<A>;

export interface McpToolSpec<I extends Schema.Codec<unknown, unknown, never, never>, R, S> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** Whether it is listed for a grant at all; the handler never runs without it. */
  readonly scope: McpScope;
  readonly input: I;
  readonly annotations?: ToolAnnotations;
  readonly run: (
    args: I["Type"],
    context: McpToolContext,
  ) => Effect.Effect<McpToolResult, McpToolError, R>;
  /**
   * Picks a turn back up after its person answered in the client. A tool
   * without it refuses a call carrying request state.
   */
  readonly resume?: (
    state: TurnRequestState,
    context: McpToolContext,
  ) => Effect.Effect<McpToolResult, McpToolError, S>;
}

export const failure = (message: string): CallToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

/**
 * A tool with its registration bound while its types are known: a list of
 * tools of different inputs cannot be registered through one generic call.
 */
export const defineTool = <I extends Schema.Codec<unknown, unknown, never, never>, R, S = never>(
  spec: McpToolSpec<I, R, S>,
) => ({
  ...spec,
  install: (
    server: McpServer,
    env: {
      principal: McpPrincipal;
      origin: string;
      run: McpRun<R | S>;
      turnState: RequestStateCodec<TurnRequestState>;
    },
  ) =>
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: toolInput(spec.input),
        ...(spec.annotations ? { annotations: spec.annotations } : {}),
      },
      (args, context) => {
        const signal = context.mcpReq.signal;
        const toolContext = {
          principal: env.principal,
          origin: env.origin,
          signal,
          server: context,
          turnState: env.turnState,
        };
        // Verified by the server before this runs; a retried call answers a
        // question and must never redo what its arguments asked for.
        const state = context.mcpReq.requestState<TurnRequestState>();
        // Answers without the state they belong to cannot be placed, and must
        // not run the arguments again: that would be a second send.
        const stray =
          state === undefined && Object.keys(context.mcpReq.inputResponses ?? {}).length > 0;
        const work: Effect.Effect<McpToolResult, McpToolError, R | S> = stray
          ? Effect.fail(refused("Those answers came back without the turn they belong to."))
          : state === undefined
            ? spec.run(args, toolContext)
            : spec.resume
              ? spec.resume(state, toolContext)
              : Effect.fail(refused("This tool doesn't take answers to questions."));
        return env.run(
          work.pipe(
            Effect.catchTag("McpToolError", (error) => Effect.succeed(failure(error.message))),
            // A defect is a bug, not something the calling model can act on.
            Effect.catchCause((cause) =>
              Effect.logError("MCP tool failed", { tool: spec.name, cause: String(cause) }).pipe(
                Effect.as(failure("Something went wrong. Try again.")),
              ),
            ),
          ),
          signal,
        );
      },
    ),
});

/**
 * A result both kinds of client can read: the data as `structuredContent`,
 * and the same as text, since many clients only show the model the text.
 */
export const result = (text: string, data?: Record<string, unknown>): CallToolResult => ({
  content: [{ type: "text", text }],
  ...(data ? { structuredContent: data } : {}),
});

export const refused = (message: string) => new McpToolError({ message });
