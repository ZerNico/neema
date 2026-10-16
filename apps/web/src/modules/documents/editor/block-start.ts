import { Lexer, type Token, type TokensList, type TokenizerThis } from "marked";

type StartIndex = { length: number; positions: number[]; next: number };

/** Discovery belongs to one blockTokens call, including each list or quote's rewritten text. */
export class DocumentLexer<ParserOutput = string, RendererOutput = string> extends Lexer<
  ParserOutput,
  RendererOutput
> {
  private starts: Map<RegExp, StartIndex> | null = null;

  override blockTokens(src: string, tokens?: Token[], lastParagraphClipped?: boolean): Token[];
  override blockTokens(
    src: string,
    tokens?: TokensList,
    lastParagraphClipped?: boolean,
  ): TokensList;
  override blockTokens(src: string, tokens: Token[] = [], lastParagraphClipped = false) {
    const outer = this.starts;
    this.starts = new Map();
    try {
      return super.blockTokens(src, tokens, lastParagraphClipped);
    } finally {
      this.starts = outer;
    }
  }

  lineStart(src: string, pattern: RegExp) {
    if (!this.starts) return firstStart(src, pattern);
    let index = this.starts.get(pattern);
    if (!index) {
      const positions: number[] = [];
      pattern.lastIndex = 0;
      for (let match = pattern.exec(src); match; match = pattern.exec(src)) {
        positions.push(match.index + 1);
        // Details' opening consumes a newline that can also precede the next opening.
        pattern.lastIndex = match.index + 1;
      }
      index = { length: src.length, positions, next: 0 };
      this.starts.set(pattern, index);
    }
    // marked consumes suffixes within this call. Nested calls have their own index.
    const offset = index.length - src.length;
    while (index.next < index.positions.length && index.positions[index.next]! <= offset)
      index.next++;
    const position = index.positions[index.next];
    return position === undefined ? -1 : position - offset;
  }
}

const firstStart = (src: string, pattern: RegExp) => {
  pattern.lastIndex = 0;
  const match = pattern.exec(src);
  return match ? match.index + 1 : -1;
};

/**
 * Where a block of ours may start in text marked would otherwise read as one
 * paragraph: only after a line break. marked asks from the paragraph's second
 * character on, so a match at 0 would cut an escaped opening ("\[date")
 * after its backslash. A block at the very start is found by its tokenizer.
 */
export const blockStart = (pattern: RegExp) => {
  const lines = new RegExp(`\\n${pattern.source}`, `${pattern.flags}g`);
  return function (this: TokenizerThis, src: string) {
    // A plain marked supplied by another consumer still uses the same discovery rules.
    return this.lexer instanceof DocumentLexer
      ? this.lexer.lineStart(src, lines)
      : firstStart(src, lines);
  };
};
