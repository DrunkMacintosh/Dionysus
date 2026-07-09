import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

type LookupResult = { address: string; family: number };
export type LookupFn = (hostname: string) => Promise<LookupResult[]>;

const defaultLookup: LookupFn = async (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

const PRIVATE_V4_RANGES: Array<[string, number]> = [
  ["0.0.0.0", 8],       // "this network"
  ["10.0.0.0", 8],      // private
  ["100.64.0.0", 10],   // CGNAT
  ["127.0.0.0", 8],     // loopback
  ["169.254.0.0", 16],  // link-local / cloud metadata
  ["172.16.0.0", 12],   // private
  ["192.168.0.0", 16],  // private
  ["192.0.0.0", 24],    // IETF protocol assignments
  ["198.18.0.0", 15],   // benchmarking
  ["224.0.0.0", 3],     // multicast + reserved (224.0.0.0–255.255.255.255)
];

function v4ToLong(ip: string): number {
  const parts = ip.split(".").map(Number);
  return (
    ((parts[0]! << 24) >>> 0) + ((parts[1]! << 16) >>> 0) +
    ((parts[2]! << 8) >>> 0) + (parts[3]! >>> 0)
  ) >>> 0;
}

function v4InRange(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (v4ToLong(ip) & mask) === (v4ToLong(base) & mask);
}

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    return PRIVATE_V4_RANGES.some(([base, bits]) => v4InRange(ip, base, bits));
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    // v4-mapped (::ffff:a.b.c.d) → recurse on the v4 part
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]!);
    if (lower === "::" || lower === "::1") return true;      // unspecified / loopback
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA fc00::/7
    if (/^fe[89ab]/.test(lower)) return true;                 // link-local fe80::/10
    if (lower.startsWith("ff")) return true;                  // multicast
    return false;
  }
  return true; // not a parseable IP → treat as unsafe
}

export async function assertPublicHost(
  hostname: string,
  lookupFn: LookupFn = defaultLookup,
): Promise<void> {
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new SsrfError(`Blocked private/reserved IP literal: ${hostname}`);
    }
    return;
  }
  let addrs: LookupResult[];
  try {
    addrs = await lookupFn(hostname);
  } catch {
    throw new SsrfError(`DNS resolution failed for ${hostname}`);
  }
  if (addrs.length === 0) throw new SsrfError(`No addresses for ${hostname}`);
  for (const { address } of addrs) {
    if (isPrivateIp(address)) {
      throw new SsrfError(
        `Blocked: ${hostname} resolves to private/reserved address ${address}`,
      );
    }
  }
}
