/** A task as stored: the editor writes every one as `- [ ]` or `- [x]`, indented when nested. */
const TASK = /^\s*- \[( |x)\] /;
const FENCE = /^\s*(`{3,}|~{3,})/;

/** How many tasks a document's Markdown holds and how many are done; null without any. */
export const taskProgress = (markdown: string) => {
  let total = 0;
  let done = 0;
  // A task line inside a code block is code, not a task.
  let fence: string | null = null;
  for (const line of markdown.split("\n")) {
    const opens = FENCE.exec(line)?.[1];
    if (opens && (fence === null || opens.startsWith(fence))) {
      fence = fence === null ? opens : null;
      continue;
    }
    if (fence !== null) continue;
    const task = TASK.exec(line);
    if (!task) continue;
    total++;
    if (task[1] === "x") done++;
  }
  return total ? { done, total } : null;
};
