// Small numeric helpers every block gets as globals, installed before the
// prelude freezes the global object. Models otherwise write them inline in
// each block, and the inline versions are where rounding drift (a bill split
// that sums to 99.99) and in-place sorts of frozen state come from. Each one
// returns new values and never touches its arguments, so it is safe while
// rendering. QuickJS already has Object.groupBy, toSorted and the like; only
// structuredClone is missing among what models reach for.

export const HELPERS = String.raw`(function () {
  "use strict";
  var g = globalThis;

  function values(list, by) {
    if (!Array.isArray(list)) return [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var v = typeof by === "function" ? by(list[i], i) : typeof by === "string" ? (list[i] == null ? undefined : list[i][by]) : list[i];
      if (typeof v === "number" && isFinite(v)) out.push(v);
    }
    return out;
  }

  g.sum = function (list, by) {
    return values(list, by).reduce(function (a, b) { return a + b; }, 0);
  };

  g.mean = function (list, by) {
    var v = values(list, by);
    return v.length === 0 ? NaN : g.sum(v) / v.length;
  };

  g.median = function (list, by) {
    var v = values(list, by).sort(function (a, b) { return a - b; });
    if (v.length === 0) return NaN;
    var mid = v.length >> 1;
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  };

  // Half away from zero, the same for negatives, and nudged by EPSILON so
  // 1.005 rounds to 1.01 as a person would, not to the 1.00 its float is.
  g.round = function (n, places) {
    n = Number(n);
    var p = Math.pow(10, Math.max(0, Math.min(10, places | 0)));
    var m = Math.round(Math.abs(n) * p * (1 + Number.EPSILON)) / p;
    return n < 0 ? -m : m;
  };

  g.range = function (start, end, step) {
    if (end === undefined) { end = start; start = 0; }
    step = step === undefined ? (end < start ? -1 : 1) : step;
    var out = [];
    if (step === 0 || !isFinite(start) || !isFinite(end) || !isFinite(step)) return out;
    // From the index, not by adding up steps: 0.1 ten times is not 1.
    var count = Math.min(10000, Math.ceil((end - start) / step));
    for (var i = 0; i < count; i++) out.push(start + i * step);
    return out;
  };

  // Equal-width bins over the data, or over [min, max] when given; the last
  // bin includes its upper edge so the maximum is counted.
  g.histogram = function (list, bins, options) {
    var v = values(list, options && options.by);
    var count = Math.max(1, Math.min(100, bins | 0 || 10));
    var lo = options && typeof options.min === "number" ? options.min : v.reduce(function (a, b) { return Math.min(a, b); }, Infinity);
    var hi = options && typeof options.max === "number" ? options.max : v.reduce(function (a, b) { return Math.max(a, b); }, -Infinity);
    if (v.length === 0 || !isFinite(lo) || !isFinite(hi) || hi < lo) return [];
    if (hi === lo) hi = lo + 1;
    var width = (hi - lo) / count;
    var out = [];
    for (var i = 0; i < count; i++) out.push({ from: lo + i * width, to: i === count - 1 ? hi : lo + (i + 1) * width, count: 0 });
    v.forEach(function (x) {
      if (x < lo || x > hi) return;
      out[Math.min(count - 1, Math.floor((x - lo) / width))].count++;
    });
    return out;
  };

  // Splits total into parts (a count for equal shares, or weights) rounded to
  // places, handing the leftover cents to the largest remainders so the
  // parts always add up to the total exactly. One share per part, in order:
  // a weight that is not a positive number gets nothing rather than shifting
  // everyone after it.
  g.allocate = function (total, parts, places) {
    var weights = Array.isArray(parts)
      ? parts.map(function (w) { return typeof w === "number" && isFinite(w) && w > 0 ? w : 0; })
      : g.range(Math.max(0, Math.min(10000, parts | 0))).map(function () { return 1; });
    var whole = g.sum(weights);
    if (whole <= 0 || !isFinite(total)) return weights.map(function () { return 0; });
    var digits = Math.max(0, Math.min(6, places === undefined ? 2 : places | 0));
    var unit = Math.pow(10, digits);
    var cents = Math.round(g.round(total, digits) * unit);
    var raw = weights.map(function (w) { return (cents * w) / whole; });
    var floors = raw.map(Math.floor);
    var left = cents - g.sum(floors);
    var order = raw.map(function (r, i) { return i; }).sort(function (a, b) {
      return (raw[b] - floors[b]) - (raw[a] - floors[a]) || a - b;
    });
    for (var i = 0; i < left; i++) floors[order[i % order.length]]++;
    return floors.map(function (c) { return c / unit; });
  };

  if (typeof g.structuredClone !== "function") {
    g.structuredClone = function (value) {
      var text = JSON.stringify(value);
      return text === undefined ? undefined : JSON.parse(text);
    };
  }
})();`;

/** The helpers as the skill names them, one line each. */
export const HELPERS_REFERENCE = [
  "sum(list, by?), mean(list, by?), median(list, by?): by is a key or (item, i) => number; non-numbers are skipped.",
  "round(n, places): rounds half up, so round(1.005, 2) is 1.01.",
  "range(n) or range(start, end, step?): numbers from start up to, not including, end.",
  "histogram(values, bins, {min?, max?, by?}?): [{from, to, count}] in equal-width bins.",
  "allocate(total, countOrWeights, places = 2): shares that add up to total exactly, e.g. allocate(100, 3) is [33.34, 33.33, 33.33].",
  "structuredClone(value) copies plain data.",
].join("\n");
