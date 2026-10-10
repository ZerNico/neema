/** Delimited text (tabs, commas, semicolons) as rows of cells, quoted fields as spreadsheets write them. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [[]];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index++;
      } else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"' && field === "") quoted = true;
    else if (character === delimiter) {
      rows.at(-1)!.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index++;
      rows.at(-1)!.push(field);
      field = "";
      rows.push([]);
    } else field += character;
  }
  rows.at(-1)!.push(field);
  // A copied range ends with a newline; that last empty row is not data.
  if (rows.length > 1 && rows.at(-1)!.length === 1 && rows.at(-1)![0] === "") rows.pop();
  return rows;
}
