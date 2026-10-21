// Chrome cannot scope style invalidation for a `:has()` outside the selector's
// last compound (`.group:has(x) .child`, Tailwind's `group-has-*`, `*:has-*`).
// One such rule, used or not, makes every DOM change restyle the whole page,
// which is most of the cost of streaming and scrolling a long chat.

const splitSelectorList = (selector) => {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < selector.length; index++) {
    const char = selector[index];
    if (char === "\\") index++;
    else if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === "," && depth === 0) {
      parts.push(selector.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(selector.slice(start));
  return parts.map((part) => part.trim());
};

/** Whether a combinator follows some `:has()` outside that `:has()`'s own argument. */
const hasNonSubjectHas = (selector) =>
  splitSelectorList(selector).some((part) => {
    let depth = 0;
    let hasDepth = 0;
    let closedHas = false;
    for (let index = 0; index < part.length; index++) {
      const char = part[index];
      if (char === "\\") {
        index++;
        continue;
      }
      if (char === "[") {
        index = part.indexOf("]", index);
        continue;
      }
      if (part.startsWith(":has(", index)) {
        if (hasDepth === 0) hasDepth = depth + 1;
        depth++;
        index += 4;
        continue;
      }
      if (char === "(") depth++;
      else if (char === ")") {
        depth--;
        if (hasDepth && depth < hasDepth) {
          hasDepth = 0;
          closedHas = true;
        }
      } else if (closedHas && !hasDepth && /[ >+~]/.test(char)) {
        // A space beside a comma or parenthesis is formatting, not a descendant combinator.
        if (char === " " && (/[,(]/.test(part[index - 1]) || /[,)]/.test(part[index + 1])))
          continue;
        return true;
      }
    }
    return false;
  });

/** Selectors in a stylesheet whose `:has()` sits on an ancestor of the styled element. */
export const nonSubjectHasSelectors = (css) =>
  Array.from(css.matchAll(/([^{}@;]+)\{/g), (match) => match[1].trim()).filter(
    (selector) => selector.includes(":has(") && hasNonSubjectHas(selector),
  );
