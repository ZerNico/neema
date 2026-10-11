import { calculateSheet, LIVE_CALC, type SheetValues } from "@chat/sheet/model/calc";
import { wireOf, type CalcPost } from "./calc-protocol.ts";

// Requests arrive faster than a big sheet calculates; only the newest is worth doing.
let latest: CalcPost | null = null;
let busy = false;
// The last calculation, which the next follows: an edit calculates only what it reaches.
let previous: SheetValues | null = null;
const drain = () => {
  busy = true;
  while (latest) {
    const request = latest;
    latest = null;
    const calc = { ...request, doc: JSON.parse(request.doc) };
    previous = calculateSheet(calc.doc, calc.context, LIVE_CALC, { previous });
    postMessage(wireOf(calc, previous));
  }
  busy = false;
};
addEventListener("message", (event: MessageEvent<CalcPost>) => {
  latest = event.data;
  if (!busy) setTimeout(drain, 0);
});
