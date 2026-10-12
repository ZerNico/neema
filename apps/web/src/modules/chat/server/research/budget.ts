import { RESEARCH_SEARCH_BUDGET } from "~/modules/tools/schema.ts";

export const RESEARCH_LIMITS = {
  calls: 120,
  outputTokens: 320_000,
  ordinaryOutput: 4_096,
  // Ceilings, not fixed sizes: report caps follow the model's context.
  reportOutput: 8_192,
  workers: 4,
  tasks: 12,
  coordinatorRounds: 5,
  toolRounds: 8,
  searches: RESEARCH_SEARCH_BUDGET.default,
  reads: 160,
  /**
   * Concurrent searches/reads across the whole run, shared by every worker.
   * Each search is one upstream query per enabled engine, so this is the
   * burst the search backend sees; bursts are what get a home IP blocked.
   */
  externalOps: 3,
  explorationMs: 20 * 60_000,
  overallMs: 25 * 60_000,
  /**
   * Provider silence, not call duration. A worker's own searches and page
   * reads run inside its model stream and each report progress, so this only
   * elapses when nothing at all is happening.
   */
  providerStallMs: 2 * 60_000,
  /** Consecutive failed search calls, across all workers, that end exploration. */
  searchOutageThreshold: 6,
} as const;

export interface ResearchOutputCaps {
  ordinary: number;
  report: number;
}

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, Math.floor(value)));

/**
 * Investigation output caps follow the model's configured context length.
 * Without one, the shared default keeps the worker and report caps unchanged.
 */
export const researchOutputCaps = (
  contextLength: number | null | undefined,
): ResearchOutputCaps => {
  const context = contextLength && contextLength > 0 ? contextLength : 64_000;
  return {
    ordinary: clamp(context * 0.2, 512, RESEARCH_LIMITS.ordinaryOutput),
    report: clamp(context * 0.2, 512, RESEARCH_LIMITS.reportOutput),
  };
};

export type ResearchCallPhase = "coordinator" | "worker" | "report" | "compaction";
export interface ResearchCallSpec {
  readonly phase: ResearchCallPhase;
  readonly maxOutputTokens: number;
}

const spec = (phase: ResearchCallPhase, maxOutputTokens: number): ResearchCallSpec => ({
  phase,
  maxOutputTokens,
});

export function researchPhaseSpecs(caps: ResearchOutputCaps, compactionOutput: number) {
  return {
    coordinator: spec("coordinator", caps.ordinary),
    worker: spec("worker", caps.ordinary),
    report: spec("report", caps.report),
    compaction: spec("compaction", compactionOutput),
  };
}

export interface ResearchRemaining {
  searches: number;
  reads: number;
  tasks: number;
  calls: number;
  minutes: number;
}

/** Synchronous admission is atomic between Effect fibers, before any asynchronous dispatch. */
export class ResearchBudget {
  calls = 0;
  reservedOutput = 0;
  pendingReports = 0;
  tasks = 0;
  searches = 0;
  reads = 0;
  webRefused = false;
  /** Consecutive searches that returned nothing usable; reset by the first success. */
  searchFailures = 0;
  /** Set once the search backend looks down for the run, not just for one query. */
  searchUnavailable = false;
  constructor(
    readonly startedAt: number,
    readonly now: () => number = Date.now,
    /** Resolved from the run's model, so reservations match what is requested. */
    readonly caps: ResearchOutputCaps = researchOutputCaps(undefined),
    readonly maxSearches: number = RESEARCH_LIMITS.searches,
  ) {}
  get exploring() {
    return this.now() < this.startedAt + RESEARCH_LIMITS.explorationMs;
  }
  /**
   * Whether more web work is worth starting. Latches off at the first refusal:
   * one worker hitting the ceiling means the run is at it, and further rounds
   * would only spend model calls on tools that must refuse.
   */
  get webAvailable() {
    return (
      this.exploring &&
      !this.webRefused &&
      !this.searchUnavailable &&
      (this.searches < this.maxSearches || this.reads < RESEARCH_LIMITS.reads)
    );
  }
  /** What is left to spend, for the soft guidance every stage prompt carries. */
  remaining(): ResearchRemaining {
    return {
      searches: Math.max(0, this.maxSearches - this.searches),
      reads: Math.max(0, RESEARCH_LIMITS.reads - this.reads),
      tasks: Math.max(0, RESEARCH_LIMITS.tasks - this.tasks),
      calls: Math.max(0, RESEARCH_LIMITS.calls - this.calls),
      minutes: Math.ceil(
        Math.max(0, this.startedAt + RESEARCH_LIMITS.explorationMs - this.now()) / 60_000,
      ),
    };
  }
  /**
   * 0..1 over the tightest exploration budget. Stages use it to converge on
   * their own well before a ceiling refuses them, which is both cheaper and
   * better research than being cut off mid-investigation.
   */
  get headroom() {
    const left = this.remaining();
    return Math.min(
      left.searches / this.maxSearches,
      left.reads / RESEARCH_LIMITS.reads,
      left.calls / RESEARCH_LIMITS.calls,
      Math.max(0, this.startedAt + RESEARCH_LIMITS.explorationMs - this.now()) /
        RESEARCH_LIMITS.explorationMs,
    );
  }
  /** Whether another task could still run. False means the run is at its bound. */
  get canDispatch() {
    // A task dispatched without web budget can only produce an uncited report.
    return this.webAvailable && this.tasks < RESEARCH_LIMITS.tasks;
  }
  admitTask() {
    if (!this.canDispatch) return false;
    // One exploratory call and every pending report must fit.
    if (
      this.calls + this.pendingReports + 2 > RESEARCH_LIMITS.calls ||
      this.reservedOutput + this.caps.ordinary + (this.pendingReports + 1) * this.caps.report >
        RESEARCH_LIMITS.outputTokens
    )
      return false;
    this.tasks++;
    this.pendingReports++;
    return true;
  }
  reserve({ phase, maxOutputTokens }: ResearchCallSpec) {
    const report = phase === "report";
    if (!report && !this.exploring) return null;
    const reportsLeft = this.pendingReports - (report ? 1 : 0);
    if (
      reportsLeft < 0 ||
      this.calls + 1 + reportsLeft > RESEARCH_LIMITS.calls ||
      this.reservedOutput + maxOutputTokens + reportsLeft * this.caps.report >
        RESEARCH_LIMITS.outputTokens
    )
      return null;
    this.calls++;
    this.reservedOutput += maxOutputTokens;
    if (report) this.pendingReports--;
    return { ordinal: this.calls, maxOutputTokens };
  }
  finish(reservation: { maxOutputTokens: number }, observedOutput: number | undefined) {
    if (
      observedOutput !== undefined &&
      Number.isFinite(observedOutput) &&
      observedOutput >= 0 &&
      observedOutput <= reservation.maxOutputTokens
    )
      this.reservedOutput -= reservation.maxOutputTokens - observedOutput;
  }
  /**
   * A worker sees one failed search and should try another phrasing; the run
   * seeing many in a row with none succeeding is the backend being down. Past
   * that point every further round is model calls spent on a wall.
   */
  observeSearch(ok: boolean) {
    if (ok) {
      this.searchFailures = 0;
      return;
    }
    this.searchFailures++;
    if (this.searchFailures >= RESEARCH_LIMITS.searchOutageThreshold) this.searchUnavailable = true;
  }
  admitWeb(kind: "search" | "read", targets: number) {
    const refuse = () => {
      this.webRefused = true;
      return false;
    };
    if (!Number.isInteger(targets) || targets < 0) return false;
    if (!this.exploring) return refuse();
    if (kind === "search") {
      if (this.searches + targets > this.maxSearches) return refuse();
      this.searches += targets;
    } else {
      if (this.reads + targets > RESEARCH_LIMITS.reads) return refuse();
      this.reads += targets;
    }
    return true;
  }
}

export const validateResearchCitations = (
  text: string,
  ids: ReadonlySet<number>,
): { text: string; invalid: boolean } => {
  let invalid = false;
  // Definitions are always synthesized from authoritative tool metadata by the UI.
  const stripped = text.replace(/^\[\^\d+\]:.*$/gm, "");
  // Models cite as [3] or [3][5] as readily as [^3]; the source list is the
  // same, so accept the plain form for registered numbers. A bracketed number
  // that is not a source is left as written rather than turned into a marker.
  const normalised = stripped.replace(/\[(\d+)\](?!\()/g, (match, number: string) =>
    ids.has(Number(number)) ? `[^${number}]` : match,
  );
  return {
    text: normalised.replace(/\[\^(\d+)\]/g, (marker, number: string) => {
      if (ids.has(Number(number))) return marker;
      invalid = true;
      return "[unverified source]";
    }),
    invalid,
  };
};
