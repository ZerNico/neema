/**
 * AWS Signature Version 4 for the few requests this client makes: a JSON POST
 * or a GET, signed with long-term access keys. Web Crypto only, so the package
 * stays free of the AWS SDK.
 */

export interface AwsKeys {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export interface SignInput {
  readonly method: string;
  readonly url: URL;
  /** Headers to sign besides `host`, lowercase names. */
  readonly headers: Readonly<Record<string, string>>;
  readonly payloadHash: string;
  readonly region: string;
  readonly service: string;
  readonly keys: AwsKeys;
  readonly date: Date;
}

const encoder = new TextEncoder();

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

export const sha256Hex = async (data: string) =>
  hex(await crypto.subtle.digest("SHA-256", encoder.encode(data)));

const hmac = async (key: ArrayBuffer | Uint8Array<ArrayBuffer>, data: string) =>
  crypto.subtle.sign(
    "HMAC",
    await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
    encoder.encode(data),
  );

/** RFC 3986 encoding, which leaves only unreserved characters bare. */
const encode = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** `20150830T123600Z`, the form both the header and the scope are cut from. */
export const amzDate = (date: Date) => date.toISOString().replace(/[-:]|\.\d{3}/g, "");

/**
 * Services other than S3 sign each path segment encoded twice. `URL` has
 * encoded it once already.
 */
const canonicalPath = (url: URL) => url.pathname.split("/").map(encode).join("/") || "/";

const canonicalQuery = (url: URL) =>
  Array.from(url.searchParams, ([key, value]) => [encode(key), encode(value)] as const)
    .toSorted(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

/** The `authorization` header for a request with exactly these signed headers. */
export const authorization = async (input: SignInput) => {
  const stamp = amzDate(input.date);
  const day = stamp.slice(0, 8);
  const headers = Object.entries({ ...input.headers, host: input.url.host })
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, " ")] as const)
    .toSorted(([a], [b]) => (a < b ? -1 : 1));
  const signedHeaders = headers.map(([name]) => name).join(";");
  const canonical = [
    input.method,
    canonicalPath(input.url),
    canonicalQuery(input.url),
    ...headers.map(([name, value]) => `${name}:${value}`),
    "",
    signedHeaders,
    input.payloadHash,
  ].join("\n");
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", stamp, scope, await sha256Hex(canonical)].join("\n");
  let key: ArrayBuffer | Uint8Array<ArrayBuffer> = encoder.encode(
    `AWS4${input.keys.secretAccessKey}`,
  );
  // Each key is the HMAC of the previous one, so the chain runs in order.
  for (const part of [day, input.region, input.service, "aws4_request"])
    // oxlint-disable-next-line no-await-in-loop
    key = await hmac(key, part);
  const signature = hex(await hmac(key, toSign));
  return `AWS4-HMAC-SHA256 Credential=${input.keys.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
};

/**
 * Region and signing name from a Bedrock host. mantle is a service of its
 * own to IAM; runtime signs as plain `bedrock`.
 */
export const bedrockScope = (url: URL): { region: string; service: string } | null => {
  const mantle = /^bedrock-mantle\.([a-z0-9-]+)\.api\.aws$/.exec(url.hostname);
  if (mantle) return { region: mantle[1]!, service: "bedrock-mantle" };
  // Runtime and the control plane that lists inference profiles.
  const runtime = /^bedrock(?:-runtime)?(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com$/.exec(
    url.hostname,
  );
  if (runtime) return { region: runtime[1]!, service: "bedrock" };
  return null;
};
