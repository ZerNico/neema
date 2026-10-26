import { randomUUID } from "node:crypto";
import type { Guest } from "./hypervisor.ts";

export interface CommandRun {
  readonly command: string;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** Characters of output kept: the start and the end, the middle left out. */
  readonly outputLimit: number;
}

export interface CommandOutcome {
  readonly exitCode: number;
  readonly output: string;
  readonly truncated: boolean;
  /** Ended by its deadline. */
  readonly timedOut: boolean;
  /** Ended by Stop. */
  readonly stopped: boolean;
}

/**
 * Keeps the first quarter and the last of `limit` characters: a build's error is usually its last
 * lines, and its first say what ran.
 */
export const outputCollector = (limit: number) => {
  const decoder = new TextDecoder();
  const headLimit = Math.floor(limit / 4);
  // Room for the line that says how much was left out.
  const tailLimit = Math.max(0, limit - headLimit - 80);
  let head = "";
  let tail = "";
  let seen = 0;
  const add = (text: string) => {
    seen += text.length;
    const toHead = text.slice(0, Math.max(0, headLimit - head.length));
    head += toHead;
    const rest = text.slice(toHead.length);
    if (rest) tail = (tail + rest).slice(-tailLimit);
  };
  return {
    push: (chunk: Buffer) => add(decoder.decode(chunk, { stream: true })),
    result() {
      add(decoder.decode());
      const omitted = seen - head.length - tail.length;
      return omitted > 0
        ? { output: `${head}\n[… ${omitted} characters left out …]\n${tail}`, truncated: true }
        : { output: head + tail, truncated: false };
    },
  };
};

/**
 * Runs one command in its own cgroup. Ending it writes `cgroup.kill`, which takes every process
 * it started, `setsid` and `nohup` ones included: killing only the shell left those holding the
 * output open, and the command never ended (measured). When the shell exits on its own, the
 * wrapper steps back out of the group and kills it too, so a server left running in the
 * background dies with its command instead of holding the output open until the deadline.
 */
const wrapper = (group: string) =>
  [
    `home=$(cut -d: -f3 /proc/self/cgroup)`,
    `mkdir ${group} && echo $$ > ${group}/cgroup.procs || exit 125`,
    `/bin/bash -lc "$1"`,
    `code=$?`,
    `echo $$ > "/sys/fs/cgroup$home/cgroup.procs"`,
    `echo 1 > ${group}/cgroup.kill`,
    `exit $code`,
  ].join("\n");

export async function runCommand(guest: Guest, run: CommandRun): Promise<CommandOutcome> {
  if (run.signal?.aborted)
    return { exitCode: 130, output: "", truncated: false, timedOut: false, stopped: true };
  const group = `/sys/fs/cgroup/cmd-${randomUUID()}`;
  const collector = outputCollector(run.outputLimit);
  let timedOut = false;
  let stopped = false;
  let killing: Promise<unknown> | undefined;
  // A kill may reach the guest before the wrapper made its group. Making the group first then
  // fails the wrapper's own mkdir, so it exits before running anything: whichever comes first,
  // nothing runs after a kill.
  const kill = () =>
    (killing ??= guest
      .run({
        argv: ["/bin/sh", "-c", `mkdir ${group} 2>/dev/null; echo 1 > ${group}/cgroup.kill`],
      })
      .catch(() => {}));
  const deadline = setTimeout(() => {
    timedOut = true;
    void kill();
  }, run.timeoutMs);
  const abort = () => {
    stopped = true;
    void kill();
  };
  run.signal?.addEventListener("abort", abort, { once: true });
  let exitCode: number;
  try {
    exitCode = await guest.stream(
      {
        // The command arrives as $1, so nothing in it is ever quoted into the wrapper.
        argv: ["/bin/sh", "-c", wrapper(group), "sh", run.command],
        cwd: run.cwd,
        ...(run.env ? { env: run.env } : {}),
      },
      collector.push,
    );
  } finally {
    clearTimeout(deadline);
    run.signal?.removeEventListener("abort", abort);
    // Whatever it left running goes with the group.
    await kill();
    // Killed processes take a moment to leave; a populated group cannot be removed.
    await guest
      .run({
        argv: [
          "/bin/sh",
          "-c",
          `for i in $(seq 100); do grep -q 'populated 0' ${group}/cgroup.events 2>/dev/null && break; sleep 0.02; done; rmdir ${group} 2>/dev/null; true`,
        ],
      })
      .catch(() => {});
  }
  return { exitCode, ...collector.result(), timedOut, stopped };
}
