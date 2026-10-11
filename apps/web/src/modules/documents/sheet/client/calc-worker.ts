import { calculateForWire, type CalcPost } from "./calc-protocol.ts";

// Requests arrive faster than a big sheet calculates; only the newest is worth doing.
let latest: CalcPost | null = null;
let busy = false;
const drain = () => {
  busy = true;
  while (latest) {
    const request = latest;
    latest = null;
    postMessage(calculateForWire({ ...request, doc: JSON.parse(request.doc) }));
  }
  busy = false;
};
addEventListener("message", (event: MessageEvent<CalcPost>) => {
  latest = event.data;
  if (!busy) setTimeout(drain, 0);
});
