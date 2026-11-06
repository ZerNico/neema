// A Chromium page for real-driver.test.ts to drive: run with Electron. It prints every input
// event the page receives as a JSON line, so the test proves what arrived, not what was sent.
const { app, BrowserWindow } = require("electron");

const page = `<!doctype html>
<title>Driver target</title>
<style>
  body { font: 16px system-ui; margin: 24px; }
  input, textarea, button { font: inherit; display: block; margin: 12px 0; }
  canvas { border: 1px solid; }
</style>
<input id="field" aria-label="Field" />
<textarea id="notes" aria-label="Notes"></textarea>
<button id="go">Go</button>
<canvas id="canvas" width="200" height="100"></canvas>
<div id="view"><a id="next" href="/next">Next page</a></div>
<script>
  const report = (event) => console.log("EVENT " + JSON.stringify(event));
  document.addEventListener("click", (e) =>
    report({ type: "click", target: e.target.id, trusted: e.isTrusted, button: e.button, detail: e.detail }));
  document.addEventListener("contextmenu", (e) => { e.preventDefault(); report({ type: "contextmenu", target: e.target.id }); });
  document.addEventListener("keydown", (e) =>
    report({ type: "keydown", target: e.target.id, key: e.key, meta: e.metaKey, trusted: e.isTrusted }));
  document.addEventListener("input", (e) => report({ type: "input", target: e.target.id, value: e.target.value }));
  // A router's link: the page changes in place, which Chromium times from the click.
  document.getElementById("next").addEventListener("click", (e) => {
    e.preventDefault();
    document.getElementById("view").textContent = "Second page";
    history.pushState({}, "", "#next");
    setTimeout(() => report({ type: "navigated" }), 300);
  });
  document.addEventListener("wheel", (e) => report({ type: "wheel", target: e.target.id, deltaY: Math.sign(e.deltaY) }));
</script>`;

// Quits with whatever started it: its stdin closes then, even when that process was killed
// before it could clean up.
process.stdin.on("end", () => app.quit());
process.stdin.resume();

app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 420,
    height: 400,
    show: false,
    title: "Driver target",
  });
  // Only the page's own reports: Electron logs warnings through the same channel.
  window.webContents.on("console-message", (event) => {
    if (event.message.startsWith("EVENT ")) process.stdout.write(`${event.message}\n`);
  });
  window.webContents.on("render-process-gone", (_event, details) =>
    process.stdout.write(`EVENT ${JSON.stringify({ type: "gone", reason: details.reason })}\n`),
  );
  window.once("ready-to-show", () => {
    // Behind whatever the person has in front, as app use finds most apps.
    window.showInactive();
    process.stdout.write(`READY ${process.pid}\n`);
  });
  window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
});
