// Vite's React Refresh preamble is inline, and HMR speaks WebSocket. A nonce
// here would switch 'unsafe-inline' off, so development names none.
const devScripts = "script-src 'self' 'unsafe-inline' 'unsafe-eval'";

/**
 * Document-shell CSP. Production admits inline script only by this request's
 * nonce (src/start.ts); without one, no inline script runs at all.
 */
export const documentCsp = (production: boolean, nonce?: string) =>
  [
    "default-src 'self'",
    !production ? devScripts : nonce ? `script-src 'self' 'nonce-${nonce}'` : "script-src 'self'",
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
