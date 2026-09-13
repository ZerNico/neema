import { createHash } from "node:crypto";
import { desktopChromeInitScript, themeInitScript } from "~/ui/boot-scripts.ts";

const scriptHash = (source: string) =>
  `'sha256-${createHash("sha256").update(source).digest("base64")}'`;

const productionScripts = `script-src 'self' ${scriptHash(themeInitScript)} ${scriptHash(desktopChromeInitScript)}`;
// Vite's React Refresh preamble is inline, and HMR speaks WebSocket.
const devScripts = "script-src 'self' 'unsafe-inline' 'unsafe-eval'";

/** Document-shell CSP. Production hashes the boot scripts; dev lets Vite inject. */
export const documentCsp = (production: boolean) =>
  [
    "default-src 'self'",
    production ? productionScripts : devScripts,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    production ? "connect-src 'self'" : "connect-src 'self' ws: wss:",
    "worker-src 'self' blob:",
    // A PDF preview is an iframe over our own bytes route, which carries no
    // CSP of its own. Documents do, and theirs refuses every ancestor, so this
    // admits the file and still not the app inside itself.
    "frame-src 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");

export const DOCUMENT_CSP = documentCsp(process.env.NODE_ENV === "production");
