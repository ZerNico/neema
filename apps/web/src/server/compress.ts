import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

const brotli = promisify(brotliCompress);
const gzipped = promisify(gzip);

/** Below this a reply fits in a packet or two either way. */
const MIN_BYTES = 1024;

/**
 * A server function's JSON reply, compressed for a client that accepts it, or
 * null to send it as it is. Only whole JSON bodies: a framed reply streams
 * records as they settle, and a compressor would hold them back. Brotli at a
 * middle quality: the default, 11, spends hundreds of milliseconds on a chat.
 */
export const compressedReply = async (
  request: Request,
  response: Response,
): Promise<Response | null> => {
  if (
    response.body === null ||
    response.headers.has("content-encoding") ||
    !response.headers.get("content-type")?.startsWith("application/json")
  )
    return null;
  // Each coding with its weight; one weighted q=0 is refused, not accepted.
  const accepted = new Set(
    (request.headers.get("accept-encoding") ?? "")
      .split(",")
      .map((part) => part.trim().toLowerCase().split(";"))
      .filter(([, weight]) => !/^\s*q=0(\.0*)?\s*$/.test(weight ?? ""))
      .map(([coding]) => coding),
  );
  const encoding = accepted.has("br") ? "br" : accepted.has("gzip") ? "gzip" : null;
  if (!encoding) return null;
  const body = Buffer.from(await response.arrayBuffer());
  const headers = new Headers(response.headers);
  headers.append("vary", "accept-encoding");
  const init = { status: response.status, statusText: response.statusText, headers };
  if (body.byteLength < MIN_BYTES) return new Response(body, init);
  const encoded =
    encoding === "br"
      ? await brotli(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } })
      : await gzipped(body);
  headers.set("content-encoding", encoding);
  headers.set("content-length", String(encoded.byteLength));
  return new Response(encoded, init);
};
