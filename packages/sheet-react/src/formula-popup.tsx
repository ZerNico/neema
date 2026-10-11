import { callAt, completionFor } from "./formula-edit.ts";
import { signatureOf } from "./formula-help.ts";

/**
 * Under a formula being typed: the functions its typed name could become, or
 * the arguments of the call the caret is in, the current one in bold.
 */
export function FormulaPopup({
  text,
  caret,
  picked,
  listSeparator,
  onPick,
  style,
}: {
  text: string;
  caret: number;
  picked: number;
  listSeparator: string;
  onPick: (name: string) => void;
  style: { top: number; left: number };
}) {
  const offered = completionFor(text, caret);
  if (offered)
    return (
      <ul
        role="listbox"
        aria-label="Functions"
        className="bg-popover text-popover-foreground border-border absolute z-50 min-w-40 rounded-md border py-1 text-xs shadow-md"
        style={style}
      >
        {offered.matches.map((name, index) => (
          <li
            key={name}
            role="option"
            aria-selected={index === picked % offered.matches.length}
            className="aria-selected:bg-accent aria-selected:text-accent-foreground cursor-pointer px-2 py-1 font-mono"
            // Picking must not take focus from the cell's input.
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onPick(name);
            }}
          >
            {name}
          </li>
        ))}
      </ul>
    );
  const call = callAt(text, caret);
  const hint = call ? signatureOf(call.name, call.argument) : null;
  if (!hint) return null;
  return (
    <div
      role="status"
      className="bg-popover text-popover-foreground border-border absolute z-50 rounded-md border px-2 py-1 font-mono text-xs whitespace-nowrap shadow-md"
      style={style}
    >
      {hint.name}(
      {hint.args.map((arg, index) => (
        <span key={arg}>
          {index ? `${listSeparator} ` : ""}
          <span className={index === hint.current ? "font-semibold" : "text-muted-foreground"}>
            {arg}
          </span>
        </span>
      ))}
      )
    </div>
  );
}
