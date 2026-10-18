import { describe, expect, it } from "vitest";
import { calculate } from "./calculate.ts";
import { XError, type Scalar } from "./evaluate.ts";
import { memoryStore } from "./memory-store.ts";

// Expected values are Microsoft's documented examples (support.microsoft.com, one page per
// function, named beside each case) or exact by hand. None comes from running this engine.

type Cells = Record<string, Scalar>;
interface Case {
  readonly formula: string;
  readonly cells?: Cells;
  /** A scalar, or the rows a spilling formula fills. */
  readonly expected: Scalar | Scalar[][];
  /** Decimal places compared, only where the documented value is rounded. */
  readonly digits?: number;
}

const limits = { errorsListed: 10, links: 10_000, spill: 10_000 };
const column = (letter: string, values: readonly Scalar[]): Cells =>
  Object.fromEntries(values.map((value, index) => [`${letter}${index + 1}`, value]));
const day = 86_400;

// STDEV, STDEVA, STDEVP, STDEVPA, VAR, VARA, VARP, VARPA examples: breaking strength of tools.
const strength = column("A", [1345, 1301, 1368, 1322, 1310, 1370, 1318, 1350, 1303, 1299]);
// Their squared deviations from the mean 1328.6 add up to 6788.4.
const squares = 6788.4;
// A number, TRUE and text: the A forms read them as 1, 1 and 0, the others skip all but the number.
const mixed = column("A", [1, true, "x"]);
// RSQ and STEYX examples.
const knownYX = { ...column("A", [2, 3, 9, 1, 8, 7, 5]), ...column("B", [6, 5, 11, 7, 5, 4, 4]) };
// COVARIANCE.P and COVAR examples.
const covariance = { ...column("A", [3, 2, 4, 5, 6]), ...column("B", [9, 7, 12, 15, 17]) };
// SUMX2MY2, SUMX2PY2 and SUMXMY2 examples.
const sumXY = { ...column("A", [2, 3, 9, 1, 8, 7, 5]), ...column("B", [6, 5, 11, 7, 5, 4, 4]) };
// MIRR example.
const mirr = column("A", [-120000, 39000, 30000, 21000, 37000, 46000, 0.1, 0.12]);
const modified = (flows: readonly number[]) => {
  const years = flows.length - 1;
  const future = flows
    .slice(1)
    .reduce((total, flow, at) => total + flow * 1.12 ** (years - at - 1), 0);
  return (future / -flows[0]!) ** (1 / years) - 1;
};
// XNPV and XIRR examples, the dates as serials: 1/1/2008, 3/1/2008, 10/30/2008, 2/15/2009, 4/1/2009.
const schedule = {
  ...column("A", [-10000, 2750, 4250, 3250, 2750]),
  ...column("B", [39448, 39508, 39751, 39859, 39904]),
};
// PERCENTRANK.INC example.
const ranked = column("A", [13, 12, 11, 8, 4, 3, 2, 1, 1, 1]);
// SERIESSUM example: cos(PI()/4) by the first four terms of its power series.
const quarter = Math.PI / 4;

const cases: Record<string, Case[]> = {
  MINA: [{ formula: "MINA(A1:A5)", cells: column("A", [false, 0.2, 0.5, 0.4, 0.8]), expected: 0 }],
  STDEV: [
    { formula: "STDEV(A1:A10)", cells: strength, expected: Math.sqrt(squares / 9), digits: 10 },
    { formula: "STDEV(A1:A3)", cells: mixed, expected: new XError("#DIV/0!") },
  ],
  STDEVA: [
    { formula: "STDEVA(A1:A10)", cells: strength, expected: Math.sqrt(squares / 9), digits: 10 },
    { formula: "STDEVA(A1:A3)", cells: mixed, expected: Math.sqrt(1 / 3), digits: 12 },
  ],
  STDEVP: [
    { formula: "STDEVP(A1:A10)", cells: strength, expected: Math.sqrt(squares / 10), digits: 10 },
    { formula: "STDEVP(A1:A3)", cells: mixed, expected: 0 },
  ],
  STDEVPA: [
    { formula: "STDEVPA(A1:A10)", cells: strength, expected: Math.sqrt(squares / 10), digits: 10 },
    { formula: "STDEVPA(A1:A3)", cells: mixed, expected: Math.sqrt(2 / 9), digits: 12 },
  ],
  VAR: [
    { formula: "VAR(A1:A10)", cells: strength, expected: squares / 9, digits: 9 },
    { formula: "VAR(A1:A3)", cells: mixed, expected: new XError("#DIV/0!") },
  ],
  VARA: [
    { formula: "VARA(A1:A10)", cells: strength, expected: squares / 9, digits: 9 },
    { formula: "VARA(A1:A3)", cells: mixed, expected: 1 / 3, digits: 12 },
  ],
  VARP: [
    { formula: "VARP(A1:A10)", cells: strength, expected: 678.84, digits: 9 },
    { formula: "VARP(A1:A3)", cells: mixed, expected: 0 },
  ],
  VARPA: [
    { formula: "VARPA(A1:A10)", cells: strength, expected: 678.84, digits: 9 },
    { formula: "VARPA(A1:A3)", cells: mixed, expected: 2 / 9, digits: 12 },
  ],
  // MODE and MODE.MULT examples.
  MODE: [{ formula: "MODE(A1:A6)", cells: column("A", [5.6, 4, 4, 3, 2, 4]), expected: 4 }],
  "MODE.MULT": [
    {
      formula: "MODE.MULT(A1:A12)",
      cells: column("A", [1, 2, 3, 4, 3, 2, 1, 2, 3, 5, 6, 1]),
      expected: [[1], [2], [3]],
    },
  ],
  // HARMEAN example.
  HARMEAN: [
    {
      formula: "HARMEAN(A1:A7)",
      cells: column("A", [4, 5, 8, 7, 11, 4, 3]),
      expected: 7 / (1 / 4 + 1 / 5 + 1 / 8 + 1 / 7 + 1 / 11 + 1 / 4 + 1 / 3),
      digits: 12,
    },
  ],
  // AVEDEV example (1.020408): the deviations from 34/7 add up to 50/7.
  AVEDEV: [
    {
      formula: "AVEDEV(A1:A7)",
      cells: column("A", [4, 5, 6, 7, 5, 4, 3]),
      expected: 50 / 49,
      digits: 12,
    },
  ],
  // DEVSQ example.
  DEVSQ: [
    {
      formula: "DEVSQ(A1:A7)",
      cells: column("A", [4, 5, 8, 7, 11, 4, 3]),
      expected: 48,
      digits: 12,
    },
  ],
  // KURT example.
  KURT: [
    {
      formula: "KURT(A1:A10)",
      cells: column("A", [3, 4, 5, 2, 3, 4, 5, 6, 4, 7]),
      expected: -0.151799637,
      digits: 9,
    },
  ],
  // SKEW.P example.
  "SKEW.P": [
    {
      formula: "SKEW.P(A1:A10)",
      cells: column("A", [3, 4, 5, 2, 3, 4, 5, 6, 4, 7]),
      expected: 0.303193,
      digits: 6,
    },
  ],
  // PERCENTILE example.
  PERCENTILE: [
    {
      formula: "PERCENTILE(A1:A4,0.3)",
      cells: column("A", [1, 3, 2, 4]),
      expected: 1.9,
      digits: 12,
    },
  ],
  // QUARTILE example.
  QUARTILE: [
    {
      formula: "QUARTILE(A1:A8,1)",
      cells: column("A", [1, 2, 4, 7, 8, 9, 10, 12]),
      expected: 3.5,
      digits: 12,
    },
  ],
  // QUARTILE.EXC example.
  "QUARTILE.EXC": [
    {
      formula: "QUARTILE.EXC(A1:A11,1)",
      cells: column("A", [6, 7, 15, 36, 39, 40, 41, 42, 43, 47, 49]),
      expected: 15,
      digits: 12,
    },
    {
      formula: "QUARTILE.EXC(A1:A11,3)",
      cells: column("A", [6, 7, 15, 36, 39, 40, 41, 42, 43, 47, 49]),
      expected: 43,
      digits: 12,
    },
  ],
  // RANK example.
  RANK: [
    { formula: "RANK(A2,A1:A5,1)", cells: column("A", [7, 3.5, 3.5, 1, 2]), expected: 3 },
    { formula: "RANK(A1,A1:A5,1)", cells: column("A", [7, 3.5, 3.5, 1, 2]), expected: 5 },
  ],
  FALSE: [{ formula: "FALSE()", expected: false }],
  HYPERLINK: [
    { formula: 'HYPERLINK("https://example.com","Example")', expected: "Example" },
    { formula: 'HYPERLINK("https://example.com")', expected: "https://example.com" },
  ],
  // SECOND example: 4:48:18 PM is 18 seconds past the minute.
  SECOND: [
    { formula: "SECOND(A1)", cells: { A1: (16 * 3600 + 48 * 60 + 18) / day }, expected: 18 },
    { formula: "SECOND(A1)", cells: { A1: (16 * 3600 + 48 * 60) / day }, expected: 0 },
  ],
  ISNONTEXT: [
    { formula: "ISNONTEXT(A1)", cells: { A1: "text" }, expected: false },
    { formula: "ISNONTEXT(A1)", cells: { A1: 1 }, expected: true },
    { formula: "ISNONTEXT(A1)", expected: true },
  ],
  "COVARIANCE.P": [
    { formula: "COVARIANCE.P(A1:A5,B1:B5)", cells: covariance, expected: 5.2, digits: 12 },
  ],
  COVAR: [{ formula: "COVAR(A1:A5,B1:B5)", cells: covariance, expected: 5.2, digits: 12 }],
  // COVARIANCE.S example (9.666666667).
  "COVARIANCE.S": [
    {
      formula: "COVARIANCE.S(A1:A3,B1:B3)",
      cells: { ...column("A", [2, 4, 8]), ...column("B", [5, 11, 12]) },
      expected: 29 / 3,
      digits: 12,
    },
  ],
  // PEARSON example.
  PEARSON: [
    {
      formula: "PEARSON(A1:A5,B1:B5)",
      cells: { ...column("A", [9, 7, 5, 3, 1]), ...column("B", [10, 6, 1, 5, 3]) },
      expected: 0.699379,
      digits: 6,
    },
  ],
  RSQ: [{ formula: "RSQ(A1:A7,B1:B7)", cells: knownYX, expected: 0.05795, digits: 5 }],
  STEYX: [{ formula: "STEYX(A1:A7,B1:B7)", cells: knownYX, expected: 3.305719, digits: 6 }],
  // FORECAST.LINEAR example, which the FORECAST page shares.
  FORECAST: [
    {
      formula: "FORECAST(30,A1:A5,B1:B5)",
      cells: { ...column("A", [6, 7, 9, 15, 21]), ...column("B", [20, 28, 31, 38, 40]) },
      expected: 10.607253,
      digits: 6,
    },
  ],
  // MIRR example: 13% after five years and -5% after three, here unrounded.
  MIRR: [
    {
      formula: "MIRR(A1:A6,A7,A8)",
      cells: mirr,
      expected: modified([-120000, 39000, 30000, 21000, 37000, 46000]),
      digits: 12,
    },
    {
      formula: "MIRR(A1:A4,A7,A8)",
      cells: mirr,
      expected: modified([-120000, 39000, 30000, 21000]),
      digits: 12,
    },
  ],
  // XNPV example (2086.6476). An hour's drift in any date moves the result by about 0.04.
  XNPV: [{ formula: "XNPV(0.09,A1:A5,B1:B5)", cells: schedule, expected: 2086.6476, digits: 4 }],
  // XIRR example.
  XIRR: [{ formula: "XIRR(A1:A5,B1:B5,0.1)", cells: schedule, expected: 0.373362535, digits: 8 }],
  // FREQUENCY example: scores counted into bins up to 70, 79, 89 and above.
  FREQUENCY: [
    {
      formula: "FREQUENCY(A1:A9,B1:B3)",
      cells: { ...column("A", [79, 85, 78, 85, 50, 81, 95, 88, 97]), ...column("B", [70, 79, 89]) },
      expected: [[1], [2], [4], [2]],
    },
  ],
  // MMULT example.
  MMULT: [
    {
      formula: "MMULT(A1:B2,C1:D2)",
      cells: { A1: 1, B1: 3, A2: 7, B2: 2, C1: 2, D1: 0, C2: 0, D2: 2 },
      expected: [
        [2, 6],
        [14, 4],
      ],
    },
  ],
  SUMX2MY2: [{ formula: "SUMX2MY2(A1:A7,B1:B7)", cells: sumXY, expected: -55 }],
  SUMX2PY2: [{ formula: "SUMX2PY2(A1:A7,B1:B7)", cells: sumXY, expected: 521 }],
  SUMXMY2: [{ formula: "SUMXMY2(A1:A7,B1:B7)", cells: sumXY, expected: 79 }],
  // LINEST example 1: slope and intercept.
  LINEST: [
    {
      formula: "LINEST(A1:A4,B1:B4,,FALSE)",
      cells: { ...column("A", [1, 9, 5, 7]), ...column("B", [0, 4, 2, 3]) },
      expected: [[2, 1]],
      digits: 10,
    },
  ],
  LOGEST: [
    // y = 2 * 3^x exactly: m then b.
    {
      formula: "LOGEST(B1:B3,A1:A3)",
      cells: { ...column("A", [1, 2, 3]), ...column("B", [6, 18, 54]) },
      expected: [[3, 2]],
      digits: 10,
    },
    // LOGEST example: its m is 1.4633.
    {
      formula: "INDEX(LOGEST(B1:B6,A1:A6),1)",
      cells: {
        ...column("A", [11, 12, 13, 14, 15, 16]),
        ...column("B", [33100, 47300, 69000, 102000, 150000, 220000]),
      },
      expected: 1.4633,
      digits: 4,
    },
  ],
  "PERCENTRANK.INC": [
    { formula: "PERCENTRANK.INC(A1:A10,2)", cells: ranked, expected: 0.333, digits: 12 },
    { formula: "PERCENTRANK.INC(A1:A10,5)", cells: ranked, expected: 0.583, digits: 12 },
  ],
  // PERCENTRANK.EXC example.
  "PERCENTRANK.EXC": [
    {
      formula: "PERCENTRANK.EXC(A1:A9,7)",
      cells: column("A", [1, 2, 3, 6, 6, 6, 7, 8, 9]),
      expected: 0.7,
      digits: 12,
    },
    {
      formula: "PERCENTRANK.EXC(A1:A9,5.43)",
      cells: column("A", [1, 2, 3, 6, 6, 6, 7, 8, 9]),
      expected: 0.381,
      digits: 12,
    },
    {
      formula: "PERCENTRANK.EXC(A1:A9,5.43,1)",
      cells: column("A", [1, 2, 3, 6, 6, 6, 7, 8, 9]),
      expected: 0.3,
      digits: 12,
    },
  ],
  // PROB example.
  PROB: [
    {
      formula: "PROB(A1:A4,B1:B4,2)",
      cells: { ...column("A", [0, 1, 2, 3]), ...column("B", [0.2, 0.3, 0.1, 0.4]) },
      expected: 0.1,
      digits: 12,
    },
    {
      formula: "PROB(A1:A4,B1:B4,1,3)",
      cells: { ...column("A", [0, 1, 2, 3]), ...column("B", [0.2, 0.3, 0.1, 0.4]) },
      expected: 0.8,
      digits: 12,
    },
  ],
  // TRIMMEAN example (3.777777778): one value off each end leaves nine adding up to 34.
  TRIMMEAN: [
    {
      formula: "TRIMMEAN(A1:A11,0.2)",
      cells: column("A", [4, 5, 6, 7, 2, 3, 4, 5, 1, 2, 3]),
      expected: 34 / 9,
      digits: 12,
    },
  ],
  // Z.TEST example.
  "Z.TEST": [
    {
      formula: "Z.TEST(A1:A10,4)",
      cells: column("A", [3, 6, 7, 8, 6, 5, 4, 2, 1, 9]),
      expected: 0.090574,
      digits: 6,
    },
    {
      formula: "Z.TEST(A1:A10,6)",
      cells: column("A", [3, 6, 7, 8, 6, 5, 4, 2, 1, 9]),
      expected: 0.863043,
      digits: 6,
    },
  ],
  SERIESSUM: [
    {
      formula: "SERIESSUM(PI()/4,0,2,A1:A4)",
      cells: column("A", [1, "=-1/FACT(2)", "=1/FACT(4)", "=-1/FACT(6)"]),
      expected: 1 - quarter ** 2 / 2 + quarter ** 4 / 24 - quarter ** 6 / 720,
      digits: 12,
    },
    {
      formula: "SERIESSUM(2,1,1,A1:A3)",
      cells: column("A", [1, 2, 3]),
      expected: 1 * 2 + 2 * 4 + 3 * 8,
    },
  ],
};

const table = Object.entries(cases).flatMap(([name, list]) =>
  list.map((each) => ({ name, ...each })),
);

describe("the function table against Excel's documented results", () => {
  it.each(table)("$name: =$formula", ({ formula, cells, expected, digits }) => {
    const sheet = memoryStore({ ...cells, Z1: `=${formula}` });
    const report = calculate(sheet.store, limits);
    expect(report.unsupported).toEqual([]);
    const rows = Array.isArray(expected) ? expected : [[expected]];
    const actual = Array.isArray(expected) ? sheet.spilled("Z1") : [[sheet.at("Z1")]];
    expect(actual.map((row) => row.length)).toEqual(rows.map((row) => row.length));
    rows.forEach((row, r) =>
      row.forEach((want, c) => {
        const got = actual[r]![c];
        if (digits !== undefined && typeof want === "number") expect(got).toBeCloseTo(want, digits);
        else expect(got).toEqual(want);
      }),
    );
  });
});

describe("functions the engine leaves to Excel", () => {
  // Their result changes with time, chance or the machine, so the cell keeps what it carried.
  it.each([
    "RAND()",
    "RANDBETWEEN(1,6)",
    "RANDARRAY(2,2)",
    "TODAY()",
    'CELL("row",A1)',
    'INFO("osversion")',
  ])("=%s", (formula) => {
    const sheet = memoryStore({ A1: 5, Z1: `=${formula}` });
    const report = calculate(sheet.store, limits);
    expect(report.unsupported).toEqual([formula.slice(0, formula.indexOf("("))]);
  });
});
