import { Buffer } from "node:buffer";
import { createRequire, isBuiltin } from "node:module";
import { parentPort } from "node:worker_threads";
import vm from "node:vm";
import { inspect as inspectValue } from "node:util";
import { Schema, SchemaAST } from "effect";
import type { JsonValue } from "~/db/schema/providers.ts";
import {
  isCustomToolFile,
  type CustomToolDefinition,
  type CustomToolModule,
  type WorkingFileRef,
  type FileRef,
} from "../authoring.ts";
import {
  CUSTOM_TOOL_LIMITS,
  CustomToolFunctionSlug,
  customToolName,
  type CustomToolFunctionManifest,
} from "../schema.ts";

const maxLogLines = 100;
const maxLogLineChars = 500;
const maxLogChars = 20_000;
const maxModuleCacheBytes = 16 * 1024 * 1024;
const moduleWrapperOpen = "(function (module, exports, require, console) {\n";
const moduleWrapperClose = "\n})";
const hostRequire = createRequire(import.meta.url);

export interface WorkerInspectRequest {
  readonly id: number;
  readonly type: "inspect";
  readonly artifactHash: string;
  readonly compiled: string;
  readonly slug: string;
}

export interface WorkerInvokeRequest {
  readonly id: number;
  readonly type: "invoke";
  readonly artifactHash: string;
  readonly compiled: string;
  readonly functionKey: string;
  readonly args: unknown;
  readonly captureLogs: boolean;
}

/** The host's answer to a `file` message: the file, or why it cannot have it. */
export interface WorkerFileReply {
  readonly type: "file";
  readonly requestId: number;
  readonly file?: {
    readonly name: string;
    readonly mediaType: string;
    readonly bytes: Uint8Array;
    readonly ref: FileRef;
  };
  readonly error?: string;
}

export type WorkerRequest = WorkerInspectRequest | WorkerInvokeRequest | WorkerFileReply;

/** A file crossing the worker boundary; `bytes` rides the transfer list. */
export interface WorkerRunFile {
  readonly name: string;
  readonly mediaType: string;
  readonly delivery: "working" | "publish";
  readonly replaces?: WorkingFileRef;
  readonly showModel: boolean;
  readonly bytes: Uint8Array;
}

export interface WorkerRunResult {
  readonly ok: boolean;
  readonly output?: string;
  readonly error?: string;
  readonly logs: ReadonlyArray<string>;
  readonly files?: ReadonlyArray<WorkerRunFile>;
}

export type WorkerResponse =
  | {
      readonly id: number;
      readonly ok: true;
      readonly value: ReadonlyArray<CustomToolFunctionManifest> | WorkerRunResult;
    }
  | { readonly id: number; readonly ok: false; readonly error: string }
  /** Mid-call: the tool decoded a file parameter and needs that file's bytes. */
  | {
      readonly id: number;
      readonly type: "file";
      readonly requestId: number;
      readonly reference: string;
    };

interface LoadedModule {
  readonly functions: CustomToolModule;
  readonly bytes: number;
  setLogSink(sink: ((line: string) => void) | undefined): void;
}

const modules = new Map<string, LoadedModule>();
let moduleCacheBytes = 0;

const message = (cause: unknown): string => {
  const value =
    cause && typeof cause === "object" && "message" in cause
      ? String((cause as { readonly message: unknown }).message)
      : String(cause);
  return value.length <= CUSTOM_TOOL_LIMITS.errorChars
    ? value
    : `${value.slice(0, CUSTOM_TOOL_LIMITS.errorChars - 1)}…`;
};

const makeRequire =
  () =>
  (specifier: string): unknown => {
    if (specifier === "effect" || isBuiltin(specifier)) return hostRequire(specifier);
    throw new Error(`Unresolved external module ${JSON.stringify(specifier)}.`);
  };

const loadModule = (artifactHash: string, compiled: string): LoadedModule => {
  const cached = modules.get(artifactHash);
  if (cached) {
    modules.delete(artifactHash);
    modules.set(artifactHash, cached);
    return cached;
  }

  let logSink: ((line: string) => void) | undefined;
  const capture = (...values: ReadonlyArray<unknown>) => logSink?.(formatLogLine(values));
  const customConsole = {
    ...console,
    log: capture,
    info: capture,
    warn: capture,
    error: capture,
    debug: capture,
    trace: capture,
    dir: capture,
    table: capture,
  };
  const script = new vm.Script(moduleWrapperOpen + compiled + moduleWrapperClose, {
    filename: `custom-tool-${artifactHash.slice(0, 12)}.cjs`,
  });
  const factory = script.runInThisContext() as (
    module: { exports: unknown },
    exports: Record<string, unknown>,
    require: (specifier: string) => unknown,
    console: Console,
  ) => void;
  const module = { exports: {} as unknown };
  factory(module, module.exports as Record<string, unknown>, makeRequire(), customConsole);
  const exported = module.exports as { readonly default?: unknown };
  const functions = (exported.default ?? module.exports) as CustomToolModule;
  if (!functions || typeof functions !== "object" || Array.isArray(functions)) {
    throw new Error("The authored module must default-export defineModule(...). ");
  }

  const loaded = {
    functions,
    bytes: Buffer.byteLength(compiled),
    setLogSink: (sink: ((line: string) => void) | undefined) => {
      logSink = sink;
    },
  } satisfies LoadedModule;
  modules.set(artifactHash, loaded);
  moduleCacheBytes += loaded.bytes;
  while (moduleCacheBytes > maxModuleCacheBytes) {
    const oldestKey = modules.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = modules.get(oldestKey);
    modules.delete(oldestKey);
    if (oldest) moduleCacheBytes -= oldest.bytes;
  }
  return loaded;
};

const formatLogLine = (values: ReadonlyArray<unknown>): string =>
  values
    .map((value) =>
      typeof value === "string"
        ? value
        : inspectValue(value, { depth: 4, breakLength: 120, maxArrayLength: 50 }),
    )
    .join(" ")
    .slice(0, maxLogLineChars);

const createLogCollector = (capture: boolean) => {
  const lines: string[] = [];
  let chars = 0;
  return {
    lines,
    write(line: string) {
      if (!capture || lines.length >= maxLogLines || chars >= maxLogChars) return;
      const bounded = line.slice(0, Math.min(maxLogLineChars, maxLogChars - chars));
      lines.push(bounded);
      chars += bounded.length;
    },
  };
};

const toProviderSchema = (
  parameters: Schema.Codec<unknown, unknown, never, unknown>,
): Record<string, JsonValue> => {
  const document = Schema.toJsonSchemaDocument(parameters);
  const schema = document.schema as Record<string, JsonValue>;
  // Read from the schema itself, not its JSON rendering: Effect has changed
  // how it renders `Struct({})` between release candidates.
  const ast = parameters.ast;
  const emptyStruct =
    SchemaAST.isObjects(ast) &&
    ast.propertySignatures.length === 0 &&
    ast.indexSignatures.length === 0;
  // A struct carrying an `identifier` comes back as a bare root `$ref`, and
  // providers want `type: "object"` at the root of tool parameters, so that
  // root definition is inlined. Nested references keep resolving via `$defs`.
  const reference = typeof schema.$ref === "string" ? schema.$ref : undefined;
  const referenced = reference?.startsWith("#/$defs/")
    ? (document.definitions[reference.slice("#/$defs/".length)] as
        | Record<string, JsonValue>
        | undefined)
    : undefined;
  const providerSchema: Record<string, JsonValue> = emptyStruct
    ? { type: "object", properties: {}, additionalProperties: false }
    : referenced && Object.keys(schema).length === 1
      ? referenced
      : schema;
  if (providerSchema.type !== "object") {
    throw new Error("A custom tool parameter schema must describe an object.");
  }
  return {
    ...providerSchema,
    ...(Object.keys(document.definitions).length > 0
      ? { $defs: document.definitions as Record<string, JsonValue> }
      : {}),
  };
};

const inspectModule = (
  request: WorkerInspectRequest,
): ReadonlyArray<CustomToolFunctionManifest> => {
  const loaded = loadModule(request.artifactHash, request.compiled);
  const entries = Object.entries(loaded.functions);
  if (entries.length === 0 || entries.length > CUSTOM_TOOL_LIMITS.functions) {
    throw new Error(
      `A module must define between 1 and ${CUSTOM_TOOL_LIMITS.functions} functions.`,
    );
  }

  let totalParametersChars = 0;
  return entries.map(([key, definition]) => {
    assertDefinition(key, definition);
    const parametersSchema = toProviderSchema(definition.parameters);
    const parametersChars = JSON.stringify(parametersSchema).length;
    if (parametersChars > CUSTOM_TOOL_LIMITS.parametersChars) {
      throw new Error(
        `Function ${key}'s parameter schema exceeds ${CUSTOM_TOOL_LIMITS.parametersChars} characters.`,
      );
    }
    totalParametersChars += parametersChars;
    if (totalParametersChars > CUSTOM_TOOL_LIMITS.totalParametersChars) {
      throw new Error(
        `The module's parameter schemas exceed ${CUSTOM_TOOL_LIMITS.totalParametersChars} characters.`,
      );
    }
    return {
      key,
      name: definition.name,
      description: definition.description,
      modelName: customToolName(request.slug, key),
      parametersSchema,
    } satisfies CustomToolFunctionManifest;
  });
};

function assertDefinition(
  key: string,
  definition: CustomToolDefinition | undefined,
): asserts definition is CustomToolDefinition {
  if (!Schema.is(CustomToolFunctionSlug)(key)) {
    throw new Error(`Invalid function key ${JSON.stringify(key)}.`);
  }
  if (!definition || typeof definition !== "object") {
    throw new Error(`Function ${key} is not a defineTool(...) value.`);
  }
  if (!definition.name.trim() || definition.name.length > CUSTOM_TOOL_LIMITS.name) {
    throw new Error(`Function ${key} has an invalid name.`);
  }
  if (
    !definition.description.trim() ||
    definition.description.length > CUSTOM_TOOL_LIMITS.description
  ) {
    throw new Error(`Function ${key} has an invalid description.`);
  }
  if (!Schema.isSchema(definition.parameters)) {
    throw new Error(`Function ${key} does not have an Effect Schema.`);
  }
  if (typeof definition.run !== "function") {
    throw new Error(`Function ${key} does not have a run function.`);
  }
}

const toJsonValue = (value: unknown, ancestors: WeakSet<object>): JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Tool results may only contain finite numbers.");
    return value;
  }
  if (typeof value === "bigint") throw new Error("Tool results may not contain BigInt values.");
  if (typeof value === "function") throw new Error("Tool results may not contain functions.");
  if (typeof value === "symbol") throw new Error("Tool results may not contain symbols.");
  if (value === undefined) throw new Error("Nested undefined values are not valid JSON.");
  if (typeof value !== "object") throw new Error("The tool returned a non-JSON value.");
  if (ancestors.has(value)) throw new Error("Tool results may not contain cycles.");
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error("Tool results may not contain symbol keys.");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const output: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new Error("Tool results may not contain sparse arrays.");
        }
        output.push(toJsonValue(value[index], ancestors));
      }
      return output;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Tool results may only contain plain JSON objects.");
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, toJsonValue(item, ancestors)]),
    );
  } finally {
    ancestors.delete(value);
  }
};

const normalizeText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return JSON.stringify(toJsonValue(value, new WeakSet()), null, 2);
};

const STALE_BUNDLE =
  "This tool was built with an older file runtime. An admin must open it in Custom tools and save it again to rebuild it.";

/**
 * `{ text?, files }` with every entry made by `file(...)` is the file form;
 * anything else, including a look-alike object without the brand, is JSON.
 */
const normalizeResult = (value: unknown): { text: string; files: WorkerRunFile[] } => {
  const shaped =
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Array.isArray((value as { files?: unknown }).files) &&
    (value as { files: unknown[] }).files.every(isCustomToolFile);
  if (!shaped) return { text: normalizeText(value), files: [] };
  const { text, files } = value as { text?: unknown; files: ReadonlyArray<WorkerRunFile> };
  if (files.length > CUSTOM_TOOL_LIMITS.files) {
    throw new Error(`A tool may return at most ${CUSTOM_TOOL_LIMITS.files} files.`);
  }
  let total = 0;
  for (const item of files) {
    // `file()` in the current runtime always sets delivery, so a file without it
    // came from a bundle built before delivery existed.
    if (item.delivery !== "working" && item.delivery !== "publish") throw new Error(STALE_BUNDLE);
    if (item.replaces && (item.delivery !== "working" || item.replaces.kind !== "working"))
      throw new Error(`File ${item.name} has an invalid replacement reference.`);
    if (item.bytes.length === 0) throw new Error(`File ${item.name} is empty.`);
    if (item.bytes.length > CUSTOM_TOOL_LIMITS.fileBytes) {
      throw new Error(`File ${item.name} exceeds ${CUSTOM_TOOL_LIMITS.fileBytes} bytes.`);
    }
    total += item.bytes.length;
  }
  if (total > CUSTOM_TOOL_LIMITS.totalFileBytes) {
    throw new Error(`Returned files exceed ${CUSTOM_TOOL_LIMITS.totalFileBytes} bytes together.`);
  }
  return {
    text: normalizeText(text),
    // Copy so a buffer the tool keeps a reference to is not detached under it.
    files: files.map((item) => ({
      name: item.name,
      mediaType: item.mediaType,
      delivery: item.delivery,
      ...(item.replaces ? { replaces: item.replaces } : {}),
      showModel: item.showModel,
      bytes: new Uint8Array(item.bytes),
    })),
  };
};

// Read by `fileInput` in the module's own copy of the authoring runtime; a
// worker runs one call at a time, so one slot is enough.
const fileResolverKey = Symbol.for("chat/custom-tools/file-resolver");
const fileReplies = new Map<
  number,
  { resolve: (file: NonNullable<WorkerFileReply["file"]>) => void; reject: (cause: Error) => void }
>();
let nextFileRequest = 1;
const requestFile = (jobId: number, reference: string) =>
  new Promise<NonNullable<WorkerFileReply["file"]>>((resolve, reject) => {
    const requestId = nextFileRequest++;
    fileReplies.set(requestId, { resolve, reject });
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker ports do not accept target origins.
    parentPort!.postMessage({
      id: jobId,
      type: "file",
      requestId,
      reference,
    } satisfies WorkerResponse);
  });

const invoke = async (request: WorkerInvokeRequest): Promise<WorkerRunResult> => {
  const logs = createLogCollector(request.captureLogs);
  (globalThis as Record<symbol, unknown>)[fileResolverKey] = (reference: string) =>
    requestFile(request.id, reference);
  try {
    const loaded = loadModule(request.artifactHash, request.compiled);
    const definition = loaded.functions[request.functionKey];
    assertDefinition(request.functionKey, definition);
    if (request.args === null || typeof request.args !== "object" || Array.isArray(request.args)) {
      throw new Error("Custom tool arguments must be an object.");
    }
    loaded.setLogSink(logs.write.bind(logs));
    const args = await Schema.decodeUnknownPromise(definition.parameters)(request.args);
    const { text, files } = normalizeResult(await definition.run(args));
    const output =
      text.length > CUSTOM_TOOL_LIMITS.resultChars
        ? `${text.slice(0, CUSTOM_TOOL_LIMITS.resultChars - 1)}…`
        : text;
    return { ok: true, output, logs: logs.lines, ...(files.length ? { files } : {}) };
  } catch (cause) {
    return { ok: false, error: message(cause), logs: logs.lines };
  } finally {
    modules.get(request.artifactHash)?.setLogSink(undefined);
    delete (globalThis as Record<symbol, unknown>)[fileResolverKey];
  }
};

const port = parentPort;
if (!port) throw new Error("The custom tool runtime worker needs a parent port.");

port.on("message", (request: WorkerRequest) => {
  if (request.type === "file") {
    const pending = fileReplies.get(request.requestId);
    fileReplies.delete(request.requestId);
    if (request.file) pending?.resolve(request.file);
    else pending?.reject(new Error(request.error ?? "That file is not available."));
    return;
  }
  Promise.resolve(request.type === "inspect" ? inspectModule(request) : invoke(request)).then(
    (value) =>
      port.postMessage(
        { id: request.id, ok: true, value } satisfies WorkerResponse,
        // File bytes move rather than copy; the worker never reads them again.
        "files" in value && value.files
          ? value.files.map((item) => item.bytes.buffer as ArrayBuffer)
          : [],
      ),
    (cause: unknown) =>
      port.postMessage({
        id: request.id,
        ok: false,
        error: message(cause),
      } satisfies WorkerResponse),
  );
});
