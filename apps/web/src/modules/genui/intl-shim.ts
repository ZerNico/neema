// QuickJS ships without Intl, and no model is trained on our format: they
// write `n.toLocaleString("de-DE", { style: "currency", currency: "EUR" })`
// as they would in any web page. Without this, that expression fails and the
// number renders blank. This covers the everyday cases (grouping, decimals,
// percent, compact, common currencies, dates) for the main locales, and
// degrades anything else to plain formatting, never to an error. `<num>` and
// `<date>` stay the better choice: they format in the reader's own locale.
// Dates are formatted in UTC, so every reader and every reload sees the same.

export const INTL_SHIM = String.raw`(function () {
  "use strict";
  if (typeof Intl !== "undefined") return;

  var SEPARATORS = {
    en: [",", "."], de: [".", ","], fr: [" ", ","], es: [".", ","], it: [".", ","],
    nl: [".", ","], pt: [".", ","], da: [".", ","], sv: [" ", ","], nb: [" ", ","],
    pl: [" ", ","], cs: [" ", ","], fi: [" ", ","], ru: [" ", ","],
    tr: [".", ","], ja: [",", "."], zh: [",", "."], ko: [",", "."]
  };
  var REGION_SEPARATORS = { "de-CH": ["’", "."], "en-IN": [",", "."], "es-MX": [",", "."], "pt-BR": [".", ","] };
  var SYMBOLS = {
    EUR: "€", USD: "$", GBP: "£", JPY: "¥", CNY: "¥", INR: "₹", KRW: "₩", CHF: "CHF",
    SEK: "kr", NOK: "kr", DKK: "kr", PLN: "zł", CZK: "Kč", CAD: "CA$", AUD: "A$",
    BRL: "R$", MXN: "MX$", TRY: "₺", RUB: "₽"
  };
  var ZERO_DECIMAL = { JPY: true, KRW: true };
  var COMPACT = {
    en: [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]],
    de: [[1e12, " Bio."], [1e9, " Mrd."], [1e6, " Mio."], [1e3, " Tsd."]]
  };
  var MONTHS = {
    en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
    de: ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"],
    fr: ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"],
    es: ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"]
  };
  var WEEKDAYS = {
    en: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
    de: ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"],
    fr: ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"],
    es: ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"]
  };

  function localeOf(locales) {
    var tag = Array.isArray(locales) ? locales[0] : locales;
    return typeof tag === "string" && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(tag) ? tag : "en-US";
  }
  function languageOf(tag) { return tag.split("-")[0].toLowerCase(); }
  function separatorsOf(tag) {
    var region = tag.split("-").slice(0, 2).join("-");
    return REGION_SEPARATORS[region] || SEPARATORS[languageOf(tag)] || SEPARATORS.en;
  }
  function digits(value, fallback, min, max) {
    var n = typeof value === "number" && isFinite(value) ? Math.floor(value) : fallback;
    return Math.min(max, Math.max(min, n));
  }

  function groupDigits(integer, separator, useGrouping) {
    if (useGrouping === false || integer.length <= 3) return integer;
    var out = "";
    for (var i = 0; i < integer.length; i++) {
      if (i > 0 && (integer.length - i) % 3 === 0) out += separator;
      out += integer[i];
    }
    return out;
  }

  function plain(value, tag, minFraction, maxFraction, useGrouping) {
    var seps = separatorsOf(tag);
    var fixed = Math.abs(value).toFixed(maxFraction);
    var parts = fixed.split(".");
    var fraction = parts[1] || "";
    while (fraction.length > minFraction && fraction[fraction.length - 1] === "0") fraction = fraction.slice(0, -1);
    var text = groupDigits(parts[0], seps[0], useGrouping) + (fraction ? seps[1] + fraction : "");
    return (value < 0 && Number(fixed) !== 0 ? "-" : "") + text;
  }

  function NumberFormat(locales, options) {
    if (!(this instanceof NumberFormat)) return new NumberFormat(locales, options);
    var o = options && typeof options === "object" ? options : {};
    this.tag = localeOf(locales);
    this.style = o.style === "percent" || o.style === "currency" || o.style === "unit" ? o.style : "decimal";
    this.currency = typeof o.currency === "string" ? o.currency.toUpperCase() : "USD";
    this.unit = typeof o.unit === "string" ? o.unit : "";
    this.compact = o.notation === "compact";
    this.useGrouping = o.useGrouping !== false;
    var defaultMax = this.style === "currency" ? (ZERO_DECIMAL[this.currency] ? 0 : 2) : this.style === "percent" ? 0 : 3;
    var defaultMin = this.style === "currency" ? defaultMax : 0;
    // As in Intl: an explicit maximum below the style's default minimum lowers the minimum.
    var max = typeof o.maximumFractionDigits === "number" ? digits(o.maximumFractionDigits, defaultMax, 0, 20) : null;
    this.minFraction = digits(o.minimumFractionDigits, max === null ? defaultMin : Math.min(defaultMin, max), 0, 20);
    this.maxFraction = Math.max(this.minFraction, max === null ? defaultMax : max);
  }
  NumberFormat.prototype.format = function (input) {
    var value = Number(input);
    if (isNaN(value)) return "NaN";
    if (!isFinite(value)) return value < 0 ? "-∞" : "∞";
    var tag = this.tag;
    var language = languageOf(tag);
    if (this.style === "percent") {
      return plain(value * 100, tag, this.minFraction, this.maxFraction, this.useGrouping) + (language === "en" ? "%" : " %");
    }
    var text;
    if (this.compact && Math.abs(value) >= 1000) {
      var steps = COMPACT[language] || COMPACT.en;
      var step = steps.filter(function (s) { return Math.abs(value) >= s[0]; })[0];
      text = plain(value / step[0], tag, 0, Math.abs(value / step[0]) < 10 ? 1 : 0, true) + step[1];
    } else {
      text = plain(value, tag, this.minFraction, this.maxFraction, this.useGrouping);
    }
    if (this.style === "currency") {
      var symbol = SYMBOLS[this.currency] || this.currency;
      var negative = text[0] === "-";
      var body = negative ? text.slice(1) : text;
      // English-speaking and East Asian locales lead with the symbol.
      var leading = language === "en" || language === "ja" || language === "zh" || language === "ko" || tag === "es-MX" || tag === "pt-BR";
      return (negative ? "-" : "") + (leading ? symbol + body : body + " " + symbol);
    }
    if (this.style === "unit" && this.unit) return text + " " + this.unit;
    return text;
  };
  NumberFormat.prototype.formatToParts = function (value) { return [{ type: "literal", value: this.format(value) }]; };
  NumberFormat.prototype.resolvedOptions = function () {
    return { locale: this.tag, style: this.style, minimumFractionDigits: this.minFraction, maximumFractionDigits: this.maxFraction };
  };

  function pad(n) { return n < 10 ? "0" + n : String(n); }

  function DateTimeFormat(locales, options) {
    if (!(this instanceof DateTimeFormat)) return new DateTimeFormat(locales, options);
    this.tag = localeOf(locales);
    this.options = options && typeof options === "object" ? options : {};
  }
  DateTimeFormat.prototype.formatDate = function (d) {
    var o = this.options;
    var language = languageOf(this.tag);
    var y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
    var names = MONTHS[language] || MONTHS.en;
    var weekday = o.weekday === "long" || o.weekday === "short" || o.dateStyle === "full"
      ? (WEEKDAYS[language] || WEEKDAYS.en)[d.getUTCDay()] : null;
    if (weekday && o.weekday === "short") weekday = weekday.slice(0, 3);
    var named = o.month === "long" || o.month === "short" || o.dateStyle === "long" || o.dateStyle === "full" || o.dateStyle === "medium";
    var text;
    if (named) {
      var month = o.month === "short" || o.dateStyle === "medium" ? names[m].slice(0, 3) : names[m];
      text = language === "en" ? month + " " + day + ", " + y : language === "de" ? day + ". " + month + " " + y : day + " " + month + " " + y;
    } else if (language === "en" && this.tag !== "en-GB") {
      text = (m + 1) + "/" + day + "/" + y;
    } else if (language === "de") {
      text = day + "." + (m + 1) + "." + y;
    } else {
      text = pad(day) + "/" + pad(m + 1) + "/" + y;
    }
    return weekday ? weekday + ", " + text : text;
  };
  DateTimeFormat.prototype.formatTime = function (d) {
    var h = d.getUTCHours(), min = pad(d.getUTCMinutes());
    if (languageOf(this.tag) === "en" && this.options.hour12 !== false && this.tag !== "en-GB") {
      return ((h % 12) || 12) + ":" + min + " " + (h < 12 ? "AM" : "PM");
    }
    return pad(h) + ":" + min;
  };
  DateTimeFormat.prototype.format = function (input) {
    var d = input instanceof Date ? input : new Date(input === undefined ? Date.now() : input);
    if (isNaN(d.getTime())) return "Invalid Date";
    var o = this.options;
    var wantsTime = o.timeStyle !== undefined || o.hour !== undefined || o.minute !== undefined;
    var wantsDate = o.dateStyle !== undefined || o.year !== undefined || o.month !== undefined || o.day !== undefined || o.weekday !== undefined || !wantsTime;
    return [wantsDate ? this.formatDate(d) : "", wantsTime ? this.formatTime(d) : ""].filter(Boolean).join(", ");
  };
  DateTimeFormat.prototype.formatToParts = function (value) { return [{ type: "literal", value: this.format(value) }]; };
  DateTimeFormat.prototype.resolvedOptions = function () { return { locale: this.tag, timeZone: "UTC" }; };

  globalThis.Intl = { NumberFormat: NumberFormat, DateTimeFormat: DateTimeFormat };
  Number.prototype.toLocaleString = function (locales, options) { return new NumberFormat(locales, options).format(this); };
  Date.prototype.toLocaleDateString = function (locales, options) {
    var o = options && typeof options === "object" ? options : {};
    var dateOnly = {};
    Object.keys(o).forEach(function (k) { if (k !== "hour" && k !== "minute" && k !== "timeStyle") dateOnly[k] = o[k]; });
    if (dateOnly.dateStyle === undefined && dateOnly.month === undefined && dateOnly.weekday === undefined) dateOnly.day = "numeric";
    return new DateTimeFormat(locales, dateOnly).format(this);
  };
  Date.prototype.toLocaleTimeString = function (locales, options) {
    var o = options && typeof options === "object" ? options : {};
    return new DateTimeFormat(locales, { hour: "numeric", hour12: o.hour12 }).format(this);
  };
  Date.prototype.toLocaleString = function (locales, options) {
    var o = options && typeof options === "object" ? options : {};
    var both = { hour: "numeric", hour12: o.hour12 };
    Object.keys(o).forEach(function (k) { both[k] = o[k]; });
    if (both.dateStyle === undefined && both.month === undefined) both.day = "numeric";
    return new DateTimeFormat(locales, both).format(this);
  };
})();`;
