// Shiki tokenizes with regular expressions in JavaScript, and compiling a
// grammar takes longer still: on the page it blocked opening a chat with code
// in it. Here it runs the same plugin the page would, one request at a time.

import { code } from "@streamdown/code";
import type { HighlightReply, HighlightRequest } from "./code-highlight.ts";

self.addEventListener("message", (event: MessageEvent<HighlightRequest>) => {
  const { id, options } = event.data;
  const reply = (result: HighlightReply["result"]) =>
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a Worker's postMessage takes no origin
    self.postMessage({ id, result } satisfies HighlightReply);
  const done = code.highlight(options, reply);
  if (done) reply(done);
});
