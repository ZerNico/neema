import { CALC, DIV0, Grid, SPILL, VALUE, XError, compare, extent, type Scalar } from "./values.ts";

/** The most cells a PIVOTBY makes, as many as a live sheet lets one formula spill into. */
export const PIVOT_CELLS = 200_000;

/**
 * Excel 365's GROUPBY and PIVOTBY: rows grouped by the values of some
 * columns, each group's values summarised by a function named as Excel's
 * eta form passes it (`=GROUPBY(A2:A9, C2:C9, SUM)`). Pivot tables here are
 * these formulas, so a pivot recalculates with its data like any formula.
 */

/** The functions a group's values can be summarised with. */
export const AGGREGATES = [
  "SUM",
  "AVERAGE",
  "COUNT",
  "COUNTA",
  "MIN",
  "MAX",
  "MEDIAN",
  "PRODUCT",
  "STDEV.S",
  "STDEV.P",
  "VAR.S",
  "VAR.P",
  "PERCENTOF",
] as const;
export type Aggregate = (typeof AGGREGATES)[number];
export const isAggregate = (name: string): name is Aggregate =>
  (AGGREGATES as readonly string[]).includes(name);

/** A function over a group's values; PERCENTOF is the group's sum as a share of `whole`. */
function summarise(fn: Aggregate, values: readonly Scalar[], whole: number): Scalar {
  const error = values.find((each): each is XError => each instanceof XError);
  if (error) return error;
  const numbers = values.filter((each): each is number => typeof each === "number");
  const sum = numbers.reduce((total, each) => total + each, 0);
  const mean = numbers.length ? sum / numbers.length : 0;
  const squares = numbers.reduce((total, each) => total + (each - mean) ** 2, 0);
  switch (fn) {
    case "SUM":
      return sum;
    case "PERCENTOF":
      return whole === 0 ? DIV0 : sum / whole;
    case "AVERAGE":
      return numbers.length ? mean : DIV0;
    case "COUNT":
      return numbers.length;
    case "COUNTA":
      return values.filter((each) => each !== null && each !== "").length;
    case "MIN":
      return numbers.length ? extent(numbers)[0] : 0;
    case "MAX":
      return numbers.length ? extent(numbers)[1] : 0;
    case "PRODUCT":
      return numbers.length ? numbers.reduce((total, each) => total * each, 1) : 0;
    case "MEDIAN": {
      if (!numbers.length) return VALUE;
      const sorted = numbers.toSorted((a, b) => a - b);
      const middle = sorted.length >> 1;
      return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
    }
    case "STDEV.S":
      return numbers.length > 1 ? Math.sqrt(squares / (numbers.length - 1)) : DIV0;
    case "STDEV.P":
      return numbers.length ? Math.sqrt(squares / numbers.length) : DIV0;
    case "VAR.S":
      return numbers.length > 1 ? squares / (numbers.length - 1) : DIV0;
    case "VAR.P":
      return numbers.length ? squares / numbers.length : DIV0;
  }
}

/** A key that groups values as Excel does: text without case, numbers as numbers. */
const keyOf = (values: readonly Scalar[]) =>
  JSON.stringify(
    values.map((each) =>
      typeof each === "string"
        ? `s${each.toLowerCase()}`
        : each instanceof XError
          ? `e${each.code}`
          : each,
    ),
  );
const compareKeys = (a: readonly Scalar[], b: readonly Scalar[]) => {
  for (let at = 0; at < a.length; at++) {
    const order = compare(a[at] ?? null, b[at] ?? null);
    if (order) return order;
  }
  return 0;
};

export interface PivotOptions {
  /** Excel's field_headers: 0 none, 1 has them but hide, 2 generate, 3 has and show; null guesses. */
  readonly headers: number | null;
  /** 0 none, 1 a grand total, 2 also subtotals by the first field; negative puts them on top. */
  readonly rowTotals: number;
  /** Result columns to sort by, 1-based, negative for descending. */
  readonly rowSort: readonly number[];
  readonly colTotals: number;
  readonly colSort: readonly number[];
  /** Which source rows count; null for all. */
  readonly filter: readonly boolean[] | null;
}

/** Whether a source has a header row, as Excel guesses: text above numbers in the values. */
const guessHeaders = (values: Grid) =>
  values.height > 1 &&
  values.rows[0]!.every((each) => typeof each === "string") &&
  values.rows[1]!.some((each) => typeof each === "number");

interface Source {
  readonly rows: readonly (readonly Scalar[])[];
  readonly cols: readonly (readonly Scalar[])[] | null;
  readonly values: readonly (readonly Scalar[])[];
  /** Names for each field, shown in a header row when asked for. */
  readonly names: { rows: Scalar[]; cols: Scalar[]; values: Scalar[] } | null;
}

/** Field names made up for a source without headers, as Excel's "Row Field 1". */
const generated = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, at) => `${prefix} ${at + 1}`);

/** The source rows that count: aligned fields, headers taken off, filtered, wholly empty ones skipped. */
function sourceOf(
  rowFields: Grid,
  colFields: Grid | null,
  values: Grid,
  options: PivotOptions,
): Source | XError {
  const height = values.height;
  if (rowFields.height !== height || (colFields && colFields.height !== height)) return VALUE;
  if (options.filter && options.filter.length !== height) return VALUE;
  const mode = options.headers ?? (guessHeaders(values) ? 3 : 0);
  if (![0, 1, 2, 3].includes(mode)) return VALUE;
  const has = mode === 1 || mode === 3;
  const start = has ? 1 : 0;
  const names =
    mode === 3
      ? {
          rows: [...rowFields.rows[0]!],
          cols: colFields ? [...colFields.rows[0]!] : [],
          values: [...values.rows[0]!],
        }
      : mode === 2
        ? {
            rows: generated("Row Field", rowFields.width),
            cols: generated("Column Field", colFields?.width ?? 0),
            values: generated("Value", values.width),
          }
        : null;
  const kept: number[] = [];
  for (let at = start; at < height; at++) {
    if (options.filter && !options.filter[at]) continue;
    const fields = [...rowFields.rows[at]!, ...(colFields?.rows[at] ?? []), ...values.rows[at]!];
    if (fields.every((each) => each === null || each === "")) continue;
    kept.push(at);
  }
  return {
    rows: kept.map((at) => rowFields.rows[at]!),
    cols: colFields ? kept.map((at) => colFields.rows[at]!) : null,
    values: kept.map((at) => values.rows[at]!),
    names,
  };
}

/** Distinct keys in order: by the sort given, else ascending by the keys. */
function distinct(keys: readonly (readonly Scalar[])[]) {
  const seen = new Map<string, readonly Scalar[]>();
  for (const key of keys) if (!seen.has(keyOf(key))) seen.set(keyOf(key), key);
  return [...seen.values()].toSorted(compareKeys);
}

/** Orders rows by result columns, 1-based, negative descending; stable otherwise. */
function sortBy(rows: Scalar[][], order: readonly number[]): Scalar[][] | XError {
  if (!order.length) return rows;
  for (const each of order) if (!Number.isInteger(each) || each === 0) return VALUE;
  return rows.toSorted((a, b) => {
    for (const each of order) {
      const at = Math.abs(each) - 1;
      const result = compare(a[at] ?? null, b[at] ?? null) * Math.sign(each);
      if (result) return result;
    }
    return 0;
  });
}

const pad = (row: Scalar[], width: number) => [
  ...row,
  ...Array.from({ length: width - row.length }, () => null),
];

/** GROUPBY: a row per distinct row-field key, each value column summarised, with totals. */
export function groupBy(
  rowFields: Grid,
  values: Grid,
  fn: Aggregate,
  options: PivotOptions,
): Grid | XError {
  const source = sourceOf(rowFields, null, values, options);
  if (source instanceof XError) return source;
  if (!source.rows.length) return CALC;
  const wholes = values.rows[0]!.map((_, column) =>
    source.values.reduce(
      (total, row) => total + (typeof row[column] === "number" ? (row[column] as number) : 0),
      0,
    ),
  );
  const summaryOf = (members: readonly number[]) =>
    values.rows[0]!.map((_, column) =>
      summarise(
        fn,
        members.map((at) => source.values[at]![column] ?? null),
        wholes[column]!,
      ),
    );
  const byKey = new Map<string, number[]>();
  source.rows.forEach((key, at) => {
    const members = byKey.get(keyOf(key));
    if (members) members.push(at);
    else byKey.set(keyOf(key), [at]);
  });
  const width = rowFields.width + values.width;
  const subtotals = Math.abs(options.rowTotals) >= 2 && rowFields.width > 1;
  // Each first field's rows, gathered once, for its subtotal.
  const byFirst = new Map<string, number[]>();
  if (subtotals)
    source.rows.forEach((key, at) => {
      const first = keyOf([key[0] ?? null]);
      const group = byFirst.get(first);
      if (group) group.push(at);
      else byFirst.set(first, [at]);
    });
  const detail = sortBy(
    distinct(source.rows).map((key) => [...key, ...summaryOf(byKey.get(keyOf(key))!)]),
    subtotals ? [1, ...options.rowSort] : options.rowSort,
  );
  if (detail instanceof XError) return detail;
  const top = options.rowTotals < 0;
  let body: Scalar[][] = detail;
  // Subtotals by the first field, beside each run of its rows.
  if (subtotals) {
    body = [];
    for (let at = 0; at < detail.length;) {
      const first = detail[at]![0] ?? null;
      let end = at;
      while (end < detail.length && compare(detail[end]![0] ?? null, first) === 0) end++;
      const members = byFirst.get(keyOf([first])) ?? [];
      const subtotal = pad([first], rowFields.width).concat(summaryOf(members));
      body.push(
        ...(top ? [subtotal, ...detail.slice(at, end)] : [...detail.slice(at, end), subtotal]),
      );
      at = end;
    }
  }
  const total =
    options.rowTotals !== 0
      ? [pad(["Total"], rowFields.width).concat(summaryOf(source.rows.map((_, at) => at)))]
      : [];
  const header = source.names ? [[...source.names.rows, ...source.names.values]] : [];
  return new Grid(
    [...header, ...(top ? total : []), ...body, ...(top ? [] : total)].map((row) =>
      pad(row, width),
    ),
  );
}

/** PIVOTBY: row keys down, column keys across, each crossing summarised, with totals both ways. */
export function pivotBy(
  rowFields: Grid,
  colFields: Grid,
  values: Grid,
  fn: Aggregate,
  options: PivotOptions,
): Grid | XError {
  const source = sourceOf(rowFields, colFields, values, options);
  if (source instanceof XError) return source;
  if (!source.rows.length) return CALC;
  const rowKeys = distinct(source.rows);
  let colKeys = distinct(source.cols!);
  if (options.colSort.length) {
    const sorted = sortBy(
      colKeys.map((key) => [...key]),
      options.colSort,
    );
    if (sorted instanceof XError) return sorted;
    colKeys = sorted;
  }
  const valueCount = values.width;
  // Refused from its size before any crossing is worked out, as a spill too large would be.
  if ((rowKeys.length + 2) * (rowFields.width + (colKeys.length + 1) * valueCount) > PIVOT_CELLS)
    return SPILL;
  // Every source row's place, gathered once: by its row key, its column key, and both.
  const rowKeyAt = source.rows.map(keyOf);
  const colKeyAt = source.cols!.map(keyOf);
  const gather = (keyAt: (at: number) => string) => {
    const groups = new Map<string, number[]>();
    for (let at = 0; at < source.values.length; at++) {
      const key = keyAt(at);
      const members = groups.get(key);
      if (members) members.push(at);
      else groups.set(key, [at]);
    }
    return groups;
  };
  const byRow = gather((at) => rowKeyAt[at]!);
  const byColumn = gather((at) => colKeyAt[at]!);
  const byBoth = gather((at) => `${rowKeyAt[at]}\u0000${colKeyAt[at]}`);
  const everyRow = source.values.map((_, at) => at);
  // Each column's total, summed once, for PERCENTOF.
  const wholes = new Map<string, number>();
  const sumOf = (members: readonly number[], column: number) =>
    members.reduce((total, at) => {
      const value = source.values[at]![column];
      return total + (typeof value === "number" ? value : 0);
    }, 0);
  const cell = (
    rowKey: readonly Scalar[] | null,
    colKey: readonly Scalar[] | null,
    column: number,
  ) => {
    const [row, col] = [rowKey && keyOf(rowKey), colKey && keyOf(colKey)];
    const members =
      (row !== null && col !== null
        ? byBoth.get(`${row}\u0000${col}`)
        : row !== null
          ? byRow.get(row)
          : col !== null
            ? byColumn.get(col)
            : everyRow) ?? [];
    if (!members.length) return null;
    // A share of the column's total, as PIVOTBY's PERCENTOF is by default; the grand total's of all.
    const wholeKey = `${col ?? ""}\u0000${column}`;
    let whole = wholes.get(wholeKey);
    if (whole === undefined) {
      whole = sumOf(col !== null ? (byColumn.get(col) ?? []) : everyRow, column);
      wholes.set(wholeKey, whole);
    }
    return summarise(
      fn,
      members.map((at) => source.values[at]![column] ?? null),
      whole,
    );
  };
  const across = [
    ...colKeys.flatMap((key) =>
      Array.from({ length: valueCount }, (_, column) => ({ key, column })),
    ),
    ...(options.colTotals !== 0
      ? Array.from({ length: valueCount }, (_, column) => ({ key: null, column }))
      : []),
  ];
  const ordered =
    options.colTotals < 0
      ? [...across.filter((each) => !each.key), ...across.filter((each) => each.key)]
      : across;
  const lead = rowFields.width;
  const headerRows: Scalar[][] = colFields.rows[0]!.map((_, field) => [
    ...Array.from({ length: lead }, () => null),
    ...ordered.map((each) => (each.key ? (each.key[field] ?? null) : field === 0 ? "Total" : null)),
  ]);
  if (valueCount > 1)
    headerRows.push([
      ...Array.from({ length: lead }, () => null),
      ...ordered.map((each) => source.names?.values[each.column] ?? `Value ${each.column + 1}`),
    ]);
  if (source.names) headerRows[headerRows.length - 1]!.splice(0, lead, ...source.names.rows);
  const detail = sortBy(
    rowKeys.map((key) => [...key, ...ordered.map((each) => cell(key, each.key, each.column))]),
    options.rowSort,
  );
  if (detail instanceof XError) return detail;
  const total =
    options.rowTotals !== 0
      ? [[...pad(["Total"], lead), ...ordered.map((each) => cell(null, each.key, each.column))]]
      : [];
  const top = options.rowTotals < 0;
  return new Grid([...headerRows, ...(top ? total : []), ...detail, ...(top ? [] : total)]);
}
