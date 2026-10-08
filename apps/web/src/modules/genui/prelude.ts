// JavaScript evaluated inside each block's QuickJS context before the block.
// It owns everything the host relies on: the state proxy that is read-only
// while rendering, the frozen clock, the seeded random source, handler
// references stamped with the render revision, and the action queue. The
// host talks to it only through `__host`, with strings in and strings out.

export const PRELUDE = String.raw`(function () {
  "use strict";
  var g = globalThis;
  var RealDate = Date;
  var MAX_NODES = 2000;
  var MAX_ITEMS = 10000;
  var nowValue = 0;
  var rendering = false;
  var inHandler = false;
  var booted = false;
  var saved = null;
  var names = [];
  var raw = Object.create(null);
  var view = Object.create(null);
  var handlers = [];
  var rev = 0;
  var nodes = 0;
  var actions = [];
  var tree = null;

  function Fatal(code) { this.code = code; }

  function clone(value) {
    if (value === undefined) return undefined;
    var text = JSON.stringify(value);
    return text === undefined ? undefined : JSON.parse(text);
  }

  function reachable(value, into) {
    if (value === null || typeof value !== "object" || into.has(value)) return into;
    into.add(value);
    Object.keys(value).forEach(function (k) { reachable(value[k], into); });
    return into;
  }

  function freezeDeep(value, seen, skip) {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) return;
    if (seen.has(value) || skip.has(value)) return;
    seen.add(value);
    Object.freeze(value);
    Object.getOwnPropertyNames(value).forEach(function (k) {
      var d = Object.getOwnPropertyDescriptor(value, k);
      if (d && "value" in d) freezeDeep(d.value, seen, skip);
    });
  }

  function snapshot() {
    var out = Object.create(null);
    names.forEach(function (n) { out[n] = raw[n]; });
    if (raw.__seed !== undefined) out.__seed = raw.__seed;
    return out;
  }

  var state = new Proxy(raw, {
    get: function (t, k) {
      if (typeof k !== "string") return undefined;
      return rendering ? view[k] : t[k];
    },
    set: function (t, k, v) {
      if (rendering) throw new TypeError("State can only change in event handlers");
      if (names.indexOf(k) === -1) return false;
      t[k] = v;
      return true;
    },
    has: function (t, k) { return typeof k === "string" && names.indexOf(k) !== -1; },
    deleteProperty: function () { return false; },
    defineProperty: function () { return false; }
  });

  function decl(name, init) {
    if (booted) throw new TypeError("$state is only allowed at the top of the script");
    if (names.indexOf(name) === -1) names.push(name);
    var has = saved !== null && Object.prototype.hasOwnProperty.call(saved, name);
    raw[name] = has ? saved[name] : clone(init());
  }

  function safe(f, fallback) {
    try { return f(); } catch (e) {
      if (e instanceof Fatal) throw e;
      return fallback;
    }
  }

  function handler(fn) {
    handlers.push(fn);
    return { $h: handlers.length - 1, rev: rev };
  }

  function prop(value) { return typeof value === "function" ? handler(value) : value; }

  function flat(children, out) {
    for (var i = 0; i < children.length; i++) {
      var c = children[i];
      if (Array.isArray(c)) flat(c, out);
      else if (c === null || c === undefined || typeof c === "boolean" || typeof c === "symbol" || typeof c === "function") continue;
      else if (typeof c === "string") out.push(c);
      else if (typeof c === "number") out.push(String(c));
      else if (typeof c === "object" && typeof c.tag === "string" && c.__node === true) out.push(c);
      else {
        try { out.push(String(c)); } catch (e) { continue; }
      }
    }
    return out;
  }

  function el(tag, props, children) {
    nodes++;
    if (nodes > MAX_NODES) throw new Fatal("tree_too_large");
    return { __node: true, tag: tag, props: props, children: flat(children, []) };
  }

  function each(list, body, fallback) {
    var items = Array.isArray(list) ? list : (list && typeof list[Symbol.iterator] === "function" ? Array.from(list) : []);
    if (items.length > MAX_ITEMS) items = items.slice(0, MAX_ITEMS);
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var index = i;
      out.push(safe(function () { return body(item, index); }, null));
    }
    return out.length > 0 ? out : fallback();
  }

  function freeze(values) {
    var skip = reachable(raw, new Set());
    var seen = new Set();
    values.forEach(function (v) { freezeDeep(v, seen, skip); });
  }

  function random() {
    if (!inHandler) throw new TypeError("random() is only available in event handlers");
    var s = (raw.__seed >>> 0) || 0x9e3779b9;
    s = (s + 0x6d2b79f5) >>> 0;
    raw.__seed = s;
    var t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function action(kind) {
    return function (value) {
      if (!inHandler) throw new TypeError(kind + "() is only available in event handlers");
      if (typeof value !== "string") throw new TypeError(kind + "() takes a string");
      // One action per event; later ones are ignored, not errors, so a
      // handler that queues two still applies its state changes.
      if (actions.length === 0) actions.push({ kind: kind, value: value });
    };
  }

  function FrozenDate() {
    if (!(this instanceof FrozenDate)) return new RealDate(nowValue).toString();
    if (arguments.length === 0) return new RealDate(nowValue);
    var args = [null].concat(Array.prototype.slice.call(arguments));
    return new (Function.prototype.bind.apply(RealDate, args))();
  }
  FrozenDate.prototype = RealDate.prototype;
  FrozenDate.now = function () { return nowValue; };
  FrozenDate.UTC = RealDate.UTC;
  FrozenDate.parse = RealDate.parse;

  var rt = Object.freeze({ state: state, decl: decl, safe: safe, prop: prop, el: el, each: each, freeze: freeze });

  function strip(value) {
    if (Array.isArray(value)) return value.map(strip);
    if (value && typeof value === "object") {
      if (value.__node === true) {
        return { tag: value.tag, props: value.props, children: value.children.map(strip) };
      }
      return value;
    }
    return value;
  }

  g.Date = FrozenDate;
  Math.random = random;
  g.random = random;
  g.send = action("send");
  g.open = action("open");
  g.copy = action("copy");
  Object.defineProperty(g, "now", { get: function () { return nowValue; } });

  g.__host = Object.freeze({
    boot: function (savedJSON, now, block) {
      if (booted) throw new TypeError("Already booted");
      nowValue = now;
      saved = savedJSON === null ? null : JSON.parse(savedJSON);
      if (saved && typeof saved === "object" && typeof saved.__seed === "number") raw.__seed = saved.__seed;
      else raw.__seed = now >>> 0;
      tree = block(rt);
      booted = true;
      Object.freeze(g);
      return "ok";
    },
    render: function () {
      rev++;
      handlers = [];
      nodes = 0;
      view = clone(snapshot()) || Object.create(null);
      freezeDeep(view, new Set(), new Set());
      rendering = true;
      try {
        return JSON.stringify({ rev: rev, nodes: strip(flat(tree(), [])) });
      } catch (e) {
        if (e instanceof Fatal) return JSON.stringify({ rev: rev, error: e.code });
        throw e;
      } finally {
        rendering = false;
      }
    },
    call: function (forRev, id, argsJSON) {
      if (forRev !== rev || !handlers[id]) return JSON.stringify({ stale: true });
      var fn = handlers[id];
      var args = JSON.parse(argsJSON);
      actions = [];
      inHandler = true;
      var error = null;
      try { fn.apply(undefined, Array.isArray(args) ? args : []); }
      catch (e) { error = e && e.message ? String(e.message) : "handler_failed"; }
      finally { inHandler = false; }
      return JSON.stringify({ actions: actions, error: error });
    },
    state: function () { return JSON.stringify(snapshot()); }
  });
})();`;
