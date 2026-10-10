import { calculateForWire, type CalcRequest } from "./calc-protocol.ts";

// Requests arrive faster than a big sheet calculates; only the newest is worth doing.
let latest: CalcRequest | null = null;
let busy = false;
const drain = () => {
  busy = true;
  while (latest) {
    const request = latest;
    latest = null;
    postMessage(calculateForWire(request));
  }
  busy = false;
};
addEventListener("message", (event: MessageEvent<CalcRequest>) => {
  latest = event.data;
  if (!busy) setTimeout(drain, 0);
});
