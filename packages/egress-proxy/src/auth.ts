import { createHash, randomBytes } from "node:crypto";
import { isUtf8 } from "node:buffer";
import type { ClientContext } from "./index.ts";
import { NameTable } from "./names.ts";

/** The fixed CONNECT username; the token is the password. */
export const USERNAME = "vm";

export interface Identity {
  readonly context: ClientContext;
  readonly names: NameTable;
  active: boolean;
  reservedTunnels: number;
  outstandingResolutions: number;
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export class Tokens {
  private readonly entries = new Map<string, Identity>();

  issue(context: ClientContext, namesPerClient: number) {
    const token = randomBytes(32).toString("base64url");
    const identity: Identity = {
      context: Object.freeze({ ...context }),
      names: new NameTable(namesPerClient),
      active: true,
      reservedTunnels: 0,
      outstandingResolutions: 0,
    };
    this.entries.set(hash(token), identity);
    return { token, identity };
  }

  authenticate(headers: ReadonlyArray<readonly [string, string]>): Identity | undefined {
    const values = headers.flatMap(([name, value]) =>
      name === "proxy-authorization" ? [value] : [],
    );
    const value = values.length === 1 ? values[0] : undefined;
    if (value === undefined) return;
    const [header, encoded] = /^Basic +([A-Za-z0-9+/]+={0,2}) *$/i.exec(value) ?? [];
    if (header !== value || encoded === undefined) return;
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.toString("base64") !== encoded || !isUtf8(decoded)) return;
    const text = decoded.toString("utf8");
    const [credentials, token] = new RegExp(`^${USERNAME}:([A-Za-z0-9_-]{43})$`).exec(text) ?? [];
    if (credentials !== text || token === undefined) return;
    const identity = this.entries.get(hash(token));
    return identity?.active ? identity : undefined;
  }

  revoke(token: string): Identity | undefined {
    const key = hash(token);
    const identity = this.entries.get(key);
    if (identity) identity.active = false;
    this.entries.delete(key);
    return identity;
  }

  clear() {
    for (const identity of this.entries.values()) identity.active = false;
    this.entries.clear();
  }
}
