/**
 * Words a person reads belong in messages/ (docs/internals/i18n.md). This
 * catches the common ways English slips back into a component: text between
 * tags, a label-like attribute, and a toast or error toast title.
 */

/** Attributes whose value a person reads or hears. */
const READ_ATTRIBUTES = new Set([
  "aria-label",
  "aria-description",
  "aria-placeholder",
  "aria-roledescription",
  "aria-valuetext",
  "alt",
  "label",
  "placeholder",
  "title",
  "description",
  "confirmLabel",
]);

/** Text that is the same in every language: the product's name, symbols, code. */
const UNTRANSLATED = /^(?:neema)$/;
const hasWords = (text) => /\p{L}{2,}/u.test(text) && !UNTRANSLATED.test(text.trim());

/** Elements whose text is code or a key, not words. */
const VERBATIM_ELEMENTS = new Set(["code", "kbd", "pre", "Kbd", "KbdGroup"]);

const elementName = (node) => {
  const name = node?.openingElement?.name;
  return name?.type === "JSXIdentifier" ? name.name : undefined;
};

const literalText = (node) => {
  if (!node) return undefined;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral")
    return node.quasis.map((quasi) => quasi.value.cooked).join(" ");
  if (node.type === "JSXExpressionContainer") return literalText(node.expression);
  return undefined;
};

const noLiteralText = {
  meta: {
    type: "problem",
    docs: { description: "Words a person reads come from messages, not literals." },
  },
  create(context) {
    const report = (node) =>
      context.report({
        node,
        message: "Move this text into apps/web/messages and render it with m.*().",
      });
    return {
      JSXText(node) {
        if (!hasWords(node.value)) return;
        if (VERBATIM_ELEMENTS.has(elementName(node.parent))) return;
        report(node);
      },
      JSXAttribute(node) {
        const name = node.name.type === "JSXIdentifier" ? node.name.name : undefined;
        if (!name || !READ_ATTRIBUTES.has(name)) return;
        const text = literalText(node.value);
        if (text !== undefined && hasWords(text)) report(node.value);
      },
      CallExpression(node) {
        const callee = node.callee;
        const toastCall =
          (callee.type === "Identifier" &&
            (callee.name === "toastError" || callee.name === "toast")) ||
          (callee.type === "MemberExpression" &&
            callee.object.type === "Identifier" &&
            callee.object.name === "toast");
        if (!toastCall) return;
        const text = literalText(node.arguments[0]);
        if (text !== undefined && hasWords(text)) report(node.arguments[0]);
      },
    };
  },
};

export default {
  meta: { name: "i18n" },
  rules: { "no-literal-text": noLiteralText },
};
