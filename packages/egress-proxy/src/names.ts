/**
 * Placeholder addresses a client's DNS gets instead of real ones, from 198.18.0.0/15 (RFC 2544
 * benchmarking, never routed). Nothing is resolved when a name is asked for, so lookups cannot
 * carry data out and a connection names exactly one host.
 */
const BASE = ((198 << 24) | (18 << 16)) >>> 0;
const SIZE = 1 << 17;

const toAddress = (offset: number) => {
  const value = BASE + offset;
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
};

/** The offset of a dotted IPv4 inside the placeholder range, or undefined outside it. */
const offsetOf = (address: string) => {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return;
  const value = ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
  const offset = value - BASE;
  return offset >= 0 && offset < SIZE ? offset : undefined;
};

export const isPlaceholder = (address: string) => offsetOf(address) !== undefined;

/** One client's names and their placeholders, stable for the client's life. */
export class NameTable {
  private readonly byName = new Map<string, string>();
  private readonly byAddress = new Map<string, string>();

  constructor(private readonly limit: number) {}

  /** The placeholder for a canonical name, assigning the next one; undefined once full. */
  address(name: string): string | undefined {
    const known = this.byName.get(name);
    if (known) return known;
    // Offset 0 is the network address; the range's last is its broadcast.
    const offset = this.byName.size + 1;
    if (this.byName.size >= this.limit || offset >= SIZE - 1) return;
    const address = toAddress(offset);
    this.byName.set(name, address);
    this.byAddress.set(address, name);
    return address;
  }

  name(address: string): string | undefined {
    return this.byAddress.get(address);
  }
}
