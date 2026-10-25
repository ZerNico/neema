import { Fragment, type ReactNode } from "react";
import type { MessagePart } from "~/paraglide/runtime.js";

type Frame = { name: string; children: ReactNode[] };

/**
 * A message with elements inside its words, such as a link mid-sentence. The
 * sentence stays one message, since German word order moves the link, and each
 * `{#name}…{/name}` in it is drawn by `tags[name]`: `<RichText parts={m.x.parts()} … />`.
 */
export function RichText({
  parts,
  tags,
}: {
  parts: ReadonlyArray<MessagePart>;
  tags: Record<string, (children: ReactNode) => ReactNode>;
}) {
  const stack: Frame[] = [{ name: "", children: [] }];
  const top = () => stack[stack.length - 1]!;
  const draw = (name: string, children: ReactNode, key: number) => (
    <Fragment key={key}>{tags[name] ? tags[name](children) : children}</Fragment>
  );
  parts.forEach((part, index) => {
    if (part.type === "text") top().children.push(part.value);
    else if (part.type === "markup-start") stack.push({ name: part.name, children: [] });
    else if (part.type === "markup-standalone") top().children.push(draw(part.name, null, index));
    else if (stack.length > 1) {
      const frame = stack.pop()!;
      top().children.push(draw(frame.name, frame.children, index));
    }
  });
  // An unclosed tag still shows its words.
  while (stack.length > 1) {
    const frame = stack.pop()!;
    top().children.push(...frame.children);
  }
  return <>{stack[0]!.children}</>;
}
