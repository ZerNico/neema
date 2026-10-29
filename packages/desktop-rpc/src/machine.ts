import { Schema } from "effect";

/**
 * Between the server and a machine: the desktop app's main process, signed in as its person,
 * running chats' tools in their VMs. The machine holds one event stream open; calls, cancels and
 * the decisions it needs arrive there, and results go back as plain POSTs. Every shape is decoded
 * on arrival on both sides. See docs/internals/desktop.md.
 */

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));

/** One answer to the model, the same shape for every tool. */
export const ToolResult = Schema.Struct({
  v: Schema.Literals([1]),
  ok: Schema.Boolean,
  /** One line for the transcript row: "Read /workspace/notes.md". */
  summary: Schema.String,
  /** What the model reads. Capped on the machine and again on the way in. */
  detail: Schema.String,
  truncated: Schema.Boolean,
  /** Network destinations refused while a command ran: `host:port` and what would lift it. */
  violations: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Bytes for the model rather than text: an image or a PDF. Never persisted. */
  file: Schema.optionalKey(
    Schema.Struct({ mediaType: Schema.String, base64: Schema.String, name: Schema.String }),
  ),
  /** The web page a browser call left its tab on, for the transcript to link. */
  page: Schema.optionalKey(Schema.Struct({ url: Schema.String, title: Schema.String })),
  /** The app an app call used, as macOS names it, for the transcript row. */
  app: Schema.optionalKey(Schema.Struct({ name: Schema.String })),
});
export type ToolResult = typeof ToolResult.Type;

/** What a machine reports about itself when it connects. */
export const MachineHello = Schema.Struct({
  machineId: Id,
  name: Schema.String.check(Schema.isMaxLength(200)),
  platform: Schema.Literals(["darwin", "win32", "linux"]),
  /** Whether chats' VMs can run here, and if not why, in the reader's words. */
  computer: Schema.Union([
    Schema.Struct({ status: Schema.Literal("ready") }),
    Schema.Struct({ status: Schema.Literal("preparing"), progress: Schema.Number }),
    Schema.Struct({ status: Schema.Literal("unavailable"), reason: Schema.String }),
  ]),
  /** Whether this machine lets calls started on other devices run. */
  remote: Schema.Boolean,
  /**
   * Whether this machine can use the person's apps: it has an app driver. Absent from shells older
   * than this field, of which only a Mac's had one.
   */
  apps: Schema.optionalKey(Schema.Boolean),
  /**
   * New each time the app starts. A call sent to an earlier launch died with it, maybe halfway,
   * so it is answered as interrupted, never sent again to run a second time.
   */
  launch: Schema.optionalKey(Id),
});
export type MachineHello = typeof MachineHello.Type;

/** A network destination a chat, or every chat of the person, may reach. */
export const DestinationGrant = Schema.Struct({
  id: Id,
  host: Schema.String,
  port: Schema.Int,
  /** Lets this name reach a private-network address. */
  privateNetwork: Schema.Boolean,
  /** Null: every chat of the person. */
  conversationId: Schema.NullOr(Id),
});
export type DestinationGrant = typeof DestinationGrant.Type;

export const MachineEvent = Schema.Union([
  /** Run a tool for a chat. `deadlineAt` is the server's clock, epoch milliseconds. */
  Schema.Struct({
    type: Schema.Literal("call"),
    callId: Id,
    conversationId: Id,
    name: Schema.String,
    args: Schema.Record(Schema.String, Schema.Unknown),
    deadlineAt: Schema.Number,
    /** Server time when sent, so the machine measures the deadline on its own clock. */
    sentAt: Schema.Number,
    /**
     * The chat's attachments and the guest path the server named each, so the model and the
     * machine agree on names. The machine places each once, and never over a file at its path.
     */
    attachments: Schema.optionalKey(
      Schema.Array(Schema.Struct({ id: Id, path: Schema.String.check(Schema.isMaxLength(1024)) })),
    ),
    /**
     * The message came from this machine, judged by the server from the sending session. Only
     * then may the machine ask its person anything; absent is false.
     */
    local: Schema.optionalKey(Schema.Boolean),
  }),
  /** Stop a call: Stop, a lost lease or the deadline. */
  Schema.Struct({ type: Schema.Literal("cancel"), callId: Id }),
  /**
   * Sent first on every connect: the calls the server still waits on from this machine, sent
   * again right after. Any other call still running here is over, its cancel lost with the old
   * stream.
   */
  Schema.Struct({ type: Schema.Literal("running"), callIds: Schema.Array(Id) }),
  /** Report this chat's folders: it was just created from this machine, which may hold some. */
  Schema.Struct({ type: Schema.Literal("folders"), conversationId: Id }),
  /** Every network grant of the person, whole each time it changes. */
  Schema.Struct({ type: Schema.Literal("grants"), grants: Schema.Array(DestinationGrant) }),
  /** A branch of a chat on this machine: its workspace files are copied, its installs are not. */
  Schema.Struct({ type: Schema.Literal("clone"), from: Id, to: Id }),
  /** A chat is gone or its environment was reset: its VM and disk go, and its workspace if gone. */
  Schema.Struct({
    type: Schema.Literal("discard"),
    conversationId: Id,
    workspace: Schema.Boolean,
  }),
]);
export type MachineEvent = typeof MachineEvent.Type;

/** What the machine posts when a chat's attached folders change: names, never paths. */
export const MachineFolders = Schema.Struct({
  conversationId: Id,
  folders: Schema.Array(
    Schema.Struct({ name: Schema.String.check(Schema.isMaxLength(200)), readOnly: Schema.Boolean }),
  ),
});
export type MachineFolders = typeof MachineFolders.Type;

/** Chats this machine holds something for; the server answers which of them no longer exist. */
export const MachineChats = Schema.Struct({
  conversationIds: Schema.Array(Id).check(Schema.isMaxLength(10_000)),
});
export type MachineChats = typeof MachineChats.Type;

/** Routes, relative to the server's origin. */
export const MACHINE_ROUTES = {
  events: "/api/machine/events",
  result: (callId: string) => `/api/machine/calls/${encodeURIComponent(callId)}/result`,
  folders: "/api/machine/folders",
  /** Which of the machine's chats are gone: purged while it was offline, so no discard came. */
  gone: "/api/machine/gone",
  /** A new hello while connected: the image finished downloading, remote control changed. */
  status: "/api/machine/status",
} as const;

/** Header carrying the hello, JSON-encoded, on the event stream's request. */
export const MACHINE_HELLO_HEADER = "x-neema-machine";
