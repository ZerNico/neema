import {
  createCipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  randomBytes,
  sign,
} from "node:crypto";

/**
 * Web Push without a library: message encryption (RFC 8291, aes128gcm) and
 * the sender's signed claim (VAPID, RFC 8292). Both are a few hash and curve
 * operations Node already has; a library would also bring its own HTTP
 * client, and push endpoints must go through our SSRF boundary instead.
 */

const RECORD_SIZE = 4096;
const encoder = new TextEncoder();

export const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
export const fromBase64url = (text: string) => new Uint8Array(Buffer.from(text, "base64url"));

const hmac = (key: Uint8Array, ...parts: Uint8Array[]) => {
  const mac = createHmac("sha256", key);
  for (const part of parts) mac.update(part);
  return new Uint8Array(mac.digest());
};
const concat = (...parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));
const one = new Uint8Array([1]);

/** A P-256 key pair: the private scalar and the uncompressed public point. */
export interface VapidKeys {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    publicKey: new Uint8Array(ecdh.getPublicKey()),
    privateKey: new Uint8Array(ecdh.getPrivateKey()),
  };
}

/**
 * The request body for one push: a single aes128gcm record whose key only the
 * subscribing browser can derive. `salt` and `senderPrivateKey` are fresh per
 * message and only fixed by tests.
 */
export function encryptPushPayload(input: {
  plaintext: Uint8Array;
  /** The subscription's `p256dh`: the browser's public key. */
  receiverPublicKey: Uint8Array;
  /** The subscription's `auth` secret. */
  authSecret: Uint8Array;
  salt?: Uint8Array;
  senderPrivateKey?: Uint8Array;
}): Uint8Array {
  const sender = createECDH("prime256v1");
  if (input.senderPrivateKey) sender.setPrivateKey(input.senderPrivateKey);
  else sender.generateKeys();
  const senderPublicKey = new Uint8Array(sender.getPublicKey());
  const salt = input.salt ?? new Uint8Array(randomBytes(16));
  const ecdhSecret = new Uint8Array(sender.computeSecret(input.receiverPublicKey));

  const prkKey = hmac(input.authSecret, ecdhSecret);
  const keyInfo = concat(
    encoder.encode("WebPush: info\0"),
    input.receiverPublicKey,
    senderPublicKey,
  );
  const ikm = hmac(prkKey, keyInfo, one);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, encoder.encode("Content-Encoding: aes128gcm\0"), one).slice(0, 16);
  const nonce = hmac(prk, encoder.encode("Content-Encoding: nonce\0"), one).slice(0, 12);

  // One record, so it is the last: the plaintext ends with the 0x02 delimiter.
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const sealed = concat(
    cipher.update(concat(input.plaintext, new Uint8Array([2]))),
    cipher.final(),
    cipher.getAuthTag(),
  );
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = senderPublicKey.length;
  return concat(header, senderPublicKey, sealed);
}

/**
 * The `Authorization` header that identifies this server to a push service: a
 * short-lived ES256 token for the endpoint's origin, and the public key the
 * browser subscribed with.
 */
export function vapidAuthorization(input: {
  endpoint: URL;
  keys: VapidKeys;
  /** A contact for the push service, `mailto:` or an https URL, when there is one. */
  subject?: string | undefined;
  now?: Date;
}): string {
  const issued = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const header = base64url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = base64url(
    encoder.encode(
      JSON.stringify({
        aud: input.endpoint.origin,
        exp: issued + 12 * 60 * 60,
        ...(input.subject ? { sub: input.subject } : {}),
      }),
    ),
  );
  const unsigned = `${header}.${claims}`;
  const point = input.keys.publicKey;
  const key = createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: base64url(input.keys.privateKey),
      x: base64url(point.slice(1, 33)),
      y: base64url(point.slice(33, 65)),
    },
    format: "jwk",
  });
  const signature = sign("sha256", encoder.encode(unsigned), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${unsigned}.${base64url(signature)}, k=${base64url(point)}`;
}
