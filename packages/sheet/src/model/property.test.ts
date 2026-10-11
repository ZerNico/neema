import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyChange } from "./apply.ts";
import { parseFormula, renderFormula } from "./formula.ts";
import { emptyDoc, emptySheet, positions, type SheetDoc } from "./model.ts";
import type { SheetChange, SheetOp } from "./ops.ts";

/** A sheet "Data" to change and a sheet "View" whose formula reads it, untouched by the changes. */
function twoSheets(rows: number): SheetDoc {
  const data = emptySheet("Data", "d.", { rows, cols: 3 });
  const view = emptySheet("View", "v.", { rows: 2, cols: 2 });
  return { ...emptyDoc(), sheets: [{ id: "d" }, { id: "v" }], sheet: { d: data, v: view } };
}

type Ref = { k: "cell"; p: number } | { k: "range"; a: number; b: number } | { k: "gone" };
type Step = { k: "insert"; after: number; n: number } | { k: "delete"; from: number; n: number };

/** Excel's own bookkeeping, by positions: what each reference reads after each step. */
function excel(refs: Ref[], step: Step): Ref[] {
  return refs.map((ref) => {
    if (ref.k === "gone") return ref;
    if (step.k === "insert") {
      const shift = (p: number) => (p > step.after ? p + step.n : p);
      return ref.k === "cell"
        ? { k: "cell", p: shift(ref.p) }
        : { k: "range", a: shift(ref.a), b: shift(ref.b) };
    }
    const [d1, d2] = [step.from, step.from + step.n - 1];
    if (ref.k === "cell")
      return ref.p >= d1 && ref.p <= d2
        ? { k: "gone" }
        : { k: "cell", p: ref.p > d2 ? ref.p - step.n : ref.p };
    const a = ref.a < d1 ? ref.a : ref.a > d2 ? ref.a - step.n : d1;
    const b = ref.b < d1 ? ref.b : ref.b > d2 ? ref.b - step.n : d1 - 1;
    return a > b ? { k: "gone" } : { k: "range", a, b };
  });
}
const excelText = (refs: Ref[]) =>
  refs
    .map((ref) =>
      ref.k === "gone" ? "#REF!" : ref.k === "cell" ? `Data!A${ref.p}` : `Data!A${ref.a}:A${ref.b}`,
    )
    .join("+");

describe("formulas against Excel's own bookkeeping", () => {
  it("read what Excel's would after any inserts and deletes", () => {
    const ref = fc.oneof(
      fc.integer({ min: 1, max: 20 }).map((p): Ref => ({ k: "cell", p })),
      fc
        .tuple(fc.integer({ min: 1, max: 20 }), fc.integer({ min: 0, max: 6 }))
        .map(([a, span]): Ref => ({ k: "range", a, b: a + span })),
    );
    const step = fc.oneof(
      fc.record({
        k: fc.constant("insert" as const),
        after: fc.integer({ min: 0, max: 30 }),
        n: fc.integer({ min: 1, max: 3 }),
      }),
      fc.record({
        k: fc.constant("delete" as const),
        from: fc.integer({ min: 1, max: 30 }),
        n: fc.integer({ min: 1, max: 3 }),
      }),
    );
    fc.assert(
      fc.property(
        fc.array(ref, { minLength: 1, maxLength: 5 }),
        fc.array(step, { maxLength: 12 }),
        (refs, steps) => {
          let doc = twoSheets(40);
          const parsed = parseFormula(excelText(refs), { doc, sheet: "v" });
          if (!("formula" in parsed)) throw new Error("grid too small");
          doc = applyChange(
            doc,
            {
              clientId: "t",
              seq: 0,
              ops: [{ op: "set", sh: "v", cells: [{ r: "v.r1", c: "v.c1", f: parsed.formula }] }],
            },
            1,
          ).doc;
          let expected = refs;
          let minted = 0;
          for (const [index, each] of steps.entries()) {
            const rows = positions(doc.sheet.d!.rows).ids;
            let op: SheetOp;
            if (each.k === "insert") {
              const after = Math.min(each.after, rows.length);
              op = {
                op: "insert",
                sh: "d",
                axis: "rows",
                ids: Array.from({ length: each.n }, () => `new${++minted}`),
                after: after === 0 ? null : rows[after - 1]!,
              };
              expected = excel(expected, { k: "insert", after, n: each.n });
            } else {
              const from = Math.min(each.from, rows.length);
              const n = Math.min(each.n, rows.length - from + 1);
              if (n < 1 || rows.length - n < 1) continue;
              op = { op: "delete", sh: "d", axis: "rows", ids: rows.slice(from - 1, from - 1 + n) };
              expected = excel(expected, { k: "delete", from, n });
            }
            doc = applyChange(doc, { clientId: "t", seq: index + 1, ops: [op] }, index + 2).doc;
            const stored = doc.sheet.v!.cells["v.r1"]!["v.c1"]!.f!;
            expect(renderFormula(stored, { doc, sheet: "v" })).toBe(excelText(expected));
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

type Message = { change: SheetChange };

/** One client: what the server confirmed, and its own changes not yet confirmed on top. */
class Client {
  confirmed: SheetDoc;
  pending: SheetChange[] = [];
  seq = 0;
  minted = 0;
  constructor(
    readonly id: string,
    doc: SheetDoc,
  ) {
    this.confirmed = doc;
  }
  /** What this client shows: its pending changes replayed over what was confirmed. */
  view(): SheetDoc {
    return this.pending.reduce(
      (doc, change) => applyChange(doc, change, Number.MAX_SAFE_INTEGER).doc,
      this.confirmed,
    );
  }
  receive(change: SheetChange, revision: number) {
    this.confirmed = applyChange(this.confirmed, change, revision).doc;
    if (change.clientId === this.id)
      this.pending = this.pending.filter((own) => own.seq !== change.seq);
  }
}

describe("replicas under the server's order", () => {
  it("all end exactly where the server is, through reordering, resends and dropped parts", () => {
    const action = fc.oneof(
      fc.record({
        k: fc.constant("edit" as const),
        client: fc.nat(2),
        what: fc.nat(3),
        a: fc.nat(40),
        b: fc.nat(40),
        value: fc.integer(),
      }),
      fc.record({ k: fc.constant("send" as const), client: fc.nat(2) }),
      fc.record({ k: fc.constant("resend" as const), client: fc.nat(2) }),
      fc.record({ k: fc.constant("deliver" as const), client: fc.nat(2), pick: fc.nat() }),
    );
    fc.assert(
      fc.property(fc.array(action, { maxLength: 60 }), (actions) => {
        const start = twoSheets(12);
        const clients = ["a", "b", "c"].map((id) => new Client(id, start));
        let server = start;
        let revision = 0;
        const lastSeq = new Map<string, number>();
        const log: SheetChange[] = [];
        // Each client sends in order, the next after the last; only clients interleave.
        const network: Message[][] = clients.map(() => []);
        // What each client has received of the log, in order.
        const delivered = clients.map(() => 0);
        const accept = (message: Message) => {
          const { change } = message;
          // Exactly the next change from a client applies; an earlier one is a
          // resend, acknowledged and dropped; a later one would skip a change.
          if (change.seq !== (lastSeq.get(change.clientId) ?? 0) + 1) return;
          lastSeq.set(change.clientId, change.seq);
          revision += 1;
          server = applyChange(server, change, revision).doc;
          log.push(change);
        };
        for (const step of actions) {
          if (step.k === "edit") {
            const client = clients[step.client]!;
            const view = client.view();
            const rows = positions(view.sheet.d!.rows).ids;
            const cols = positions(view.sheet.d!.cols).ids;
            const row = rows[step.a % rows.length]!;
            const col = cols[step.b % cols.length]!;
            const ops: SheetOp[] =
              step.what === 0
                ? [{ op: "set", sh: "d", cells: [{ r: row, c: col, v: step.value }] }]
                : step.what === 1
                  ? [
                      {
                        op: "insert",
                        sh: "d",
                        axis: "rows",
                        ids: [`${client.id}.${++client.minted}`],
                        after: row,
                      },
                    ]
                  : step.what === 2 && rows.length > 2
                    ? [{ op: "delete", sh: "d", axis: "rows", ids: [row] }]
                    : [
                        {
                          op: "format",
                          sh: "d",
                          area: { r1: row, r2: row, c1: col, c2: col },
                          patch: { bold: step.value % 2 === 0 },
                        },
                      ];
            const change = { clientId: client.id, seq: ++client.seq, ops };
            client.pending.push(change);
            network[step.client]!.push({ change });
          } else if (step.k === "send") {
            const message = network[step.client]!.shift();
            if (message) accept(message);
          } else if (step.k === "resend") {
            // A reconnect sends everything unconfirmed again, some of it already applied.
            for (const change of clients[step.client]!.pending)
              network[step.client]!.push({ change });
          } else if (step.k === "deliver") {
            const index = step.client;
            if (delivered[index]! < log.length) {
              clients[index]!.receive(log[delivered[index]!]!, delivered[index]! + 1);
              delivered[index]! += 1;
            }
          }
        }
        // Everything in flight, then a last resend of what is still unconfirmed.
        for (const queue of network) while (queue.length) accept(queue.shift()!);
        for (const client of clients) for (const change of client.pending) accept({ change });
        clients.forEach((client, index) => {
          while (delivered[index]! < log.length) {
            client.receive(log[delivered[index]!]!, delivered[index]! + 1);
            delivered[index]! += 1;
          }
        });
        for (const client of clients) {
          expect(client.pending).toEqual([]);
          expect(client.confirmed).toEqual(server);
          expect(client.view()).toEqual(server);
        }
      }),
      { numRuns: 200 },
    );
  });
});
