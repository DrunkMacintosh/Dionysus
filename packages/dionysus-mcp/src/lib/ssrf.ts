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

// Expand any valid IPv6 string into its 8 16-bit hextets, handling "::"
// compression and a trailing dotted-quad (e.g. ::ffff:127.0.0.1). Returns
// null on anything unparseable → callers treat that as "not embedded v4".
function ipv6ToHextets(ip: string): number[] | null {
  let str = ip.toLowerCase().split("%")[0]!; // drop any zone id
  // Fold a trailing dotted-quad into two hex hextets so the rest is pure hex.
  if (str.includes(".")) {
    const colon = str.lastIndexOf(":");
    if (colon === -1) return null;
    const parts = str.slice(colon + 1).split(".");
    if (parts.length !== 4) return null;
    const octets = parts.map(Number);
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const [a, b, c, d] = octets as [number, number, number, number];
    const h1 = ((a << 8) | b).toString(16);
    const h2 = ((c << 8) | d).toString(16);
    str = `${str.slice(0, colon + 1)}${h1}:${h2}`;
  }
  const dbl = str.indexOf("::");
  let groups: string[];
  if (dbl !== -1) {
    if (str.indexOf("::", dbl + 1) !== -1) return null; // more than one "::"
    const head = str.slice(0, dbl).split(":").filter((g) => g !== "");
    const tail = str.slice(dbl + 2).split(":").filter((g) => g !== "");
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...new Array(missing).fill("0"), ...tail];
  } else {
    groups = str.split(":");
  }
  if (groups.length !== 8) return null;
  const hextets = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  if (hextets.some((h) => Number.isNaN(h))) return null;
  return hextets;
}

// Reconstruct a dotted-quad IPv4 from two adjacent 16-bit hextets (high, low).
function hextetsToDottedQuad(hi: number, lo: number): string {
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

// If the IPv6 address carries an embedded IPv4 — return that IPv4 as a dotted
// string, else null. Four embeddings are decoded, each with an exact prefix
// match so no global-unicast address can be mistaken for embedded v4:
//   * v4-mapped   (::ffff:0:0/96) — hextets 0-4 zero, hextet 5 == 0xffff, v4 in 6-7
//   * v4-compat   (::/96)         — hextets 0-4 zero, hextet 5 == 0,      v4 in 6-7
//   * NAT64       (64:ff9b::/96)  — hextets 0-5 == [0x0064,0xff9b,0,0,0,0], v4 in 6-7
//   * 6to4        (2002::/16)     — hextet 0 == 0x2002,                    v4 in 1-2
// The reconstructed v4 is re-classified by isPrivateIp, so a NAT64/6to4 wrapper
// around a private/metadata address (e.g. 64:ff9b::a9fe:a9fe → 169.254.169.254)
// is blocked, while one wrapping a public address (64:ff9b::808:808 → 8.8.8.8)
// stays allowed. Normal global unicast (2001:db8::1 starts 0x2001, not 0x2002;
// 2606:4700:4700::1111 starts 0x2606) never matches any prefix → returns null.
function embeddedIpv4(hextets: number[]): string | null {
  const firstFiveZero =
    hextets[0] === 0 && hextets[1] === 0 && hextets[2] === 0 &&
    hextets[3] === 0 && hextets[4] === 0;
  if (firstFiveZero) {
    const h6 = hextets[5];
    if (h6 !== 0 && h6 !== 0xffff) return null; // v4-mapped or v4-compatible only
    return hextetsToDottedQuad(hextets[6]!, hextets[7]!);
  }
  // NAT64 well-known prefix 64:ff9b::/96 → hextets 0-5 == [0x0064,0xff9b,0,0,0,0].
  if (
    hextets[0] === 0x0064 && hextets[1] === 0xff9b &&
    hextets[2] === 0 && hextets[3] === 0 && hextets[4] === 0 && hextets[5] === 0
  ) {
    return hextetsToDottedQuad(hextets[6]!, hextets[7]!);
  }
  // 6to4 2002::/16 → leading hextet 0x2002, embedded v4 in hextets 1-2.
  if (hextets[0] === 0x2002) {
    return hextetsToDottedQuad(hextets[1]!, hextets[2]!);
  }
  return null;
}

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    return PRIVATE_V4_RANGES.some(([base, bits]) => v4InRange(ip, base, bits));
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === "::" || lower === "::1") return true;      // unspecified / loopback
    // Any embedded IPv4 (hex OR dotted, mapped OR compatible) → classify the v4.
    const hextets = ipv6ToHextets(lower);
    if (hextets) {
      const v4 = embeddedIpv4(hextets);
      if (v4 !== null) return isPrivateIp(v4);
    }
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA fc00::/7
    if (/^fe[89abcdef]/.test(lower)) return true;             // link-local fe80::/10 + site-local fec0::/10
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

import { Agent, request as undiciRequest } from "undici";
import type { LookupAddress, LookupOptions } from "node:dns";

export type SafeFetchOptions = {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  lookupFn?: LookupFn;
  /** TEST-ONLY seams. Never set in production code paths. */
  __testAllowPrivate?: boolean;
  __testAllowHosts?: string[];
};

export type SafeFetchResult = {
  status: number;
  contentType: string;
  body: string;
  finalUrl: string;
};

const ALLOWED_PORTS = new Set(["", "80", "443"]);

async function assertHostAllowed(hostname: string, opts: SafeFetchOptions): Promise<void> {
  if (opts.__testAllowPrivate) return;
  if (opts.__testAllowHosts?.includes(hostname)) return;
  await assertPublicHost(hostname, opts.lookupFn);
}

// Matches node's `net.LookupFunction` shape (what undici forwards to net.connect).
// node calls this with `{ all: true }`, so the callback must receive an ARRAY of
// { address, family } in that mode; otherwise a single (address, family) pair.
type ConnectLookup = (
  hostname: string,
  options: LookupOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
) => void;

export async function safeFetch(
  rawUrl: string,
  opts: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const maxBytes = opts.maxBytes ?? 2_000_000;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxRedirects = opts.maxRedirects ?? 3;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError(`Invalid URL: ${rawUrl}`);
  }

  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new SsrfError(`Blocked scheme: ${url.protocol}`);
    }
    if (!ALLOWED_PORTS.has(url.port) && !opts.__testAllowPrivate && !opts.__testAllowHosts) {
      // test seams use an ephemeral local port; production allows only 80/443
      throw new SsrfError(`Blocked port: ${url.port}`);
    }
    await assertHostAllowed(url.hostname, opts);

    // Guarded agent: re-validate at socket connect time (DNS-rebinding defense).
    // The connect guard honors the same TEST-ONLY seams as assertHostAllowed so
    // that allowlisted hosts (which may legitimately resolve to loopback in tests)
    // can be reached, while every real resolved address is still IP-checked. This
    // keeps per-hop redirect re-validation genuinely exercised (a redirect target
    // that is NOT allowlisted still gets blocked at assertHostAllowed above).
    const lookupFn = opts.lookupFn;
    const guardedLookup: ConnectLookup = (hostname, options, cb) => {
      const hostSeamAllowed =
        opts.__testAllowPrivate === true ||
        (opts.__testAllowHosts?.includes(hostname) ?? false);
      const doLookup = lookupFn
        ? lookupFn(hostname)
        : import("node:dns/promises").then((d) => d.lookup(hostname, { all: true, verbatim: true }));
      doLookup
        .then((addrs) => {
          const list = Array.isArray(addrs) ? addrs : [addrs];
          const bad = list.find((a) => !hostSeamAllowed && isPrivateIp(a.address));
          if (bad) return cb(new SsrfError(`Blocked at connect: ${bad.address}`), "", 0);
          if (options?.all) {
            cb(null, list.map((a) => ({ address: a.address, family: a.family })));
          } else {
            const first = list[0]!;
            cb(null, first.address, first.family);
          }
        })
        .catch((e) => cb(e as NodeJS.ErrnoException, "", 0));
    };
    const agent = new Agent({ connect: { lookup: guardedLookup } });

    // A fresh guarded Agent is created per hop; it MUST be released on every
    // exit path (return, continue, throw) or its sockets/timers leak on the hot
    // scrape/brand path. The finally closes it. On the 2xx return path the body
    // is fully drained into `chunks` BEFORE this block returns, so agent.close()
    // can never truncate the response we hand back.
    try {
      // NOTE: undici's `request` does not follow redirects by default (redirect
      // following is an opt-in interceptor). We deliberately do NOT enable it —
      // every 3xx is surfaced to our manual, per-hop-revalidated loop below.
      const res = await undiciRequest(url, {
        method: "GET",
        dispatcher: agent,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
        headers: { "user-agent": "dionysus-mcp/0.1 (+verified-read-only)" },
      });

      if (res.statusCode >= 300 && res.statusCode < 400) {
        const loc = res.headers["location"];
        await res.body.dump();
        if (!loc || typeof loc !== "string") throw new SsrfError("Redirect without location");
        if (hop === maxRedirects) throw new SsrfError(`Too many redirects (> ${maxRedirects})`);
        url = new URL(loc, url); // relative or absolute — re-validated on next loop
        continue;
      }

      const contentType = String(res.headers["content-type"] ?? "");
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of res.body) {
        total += (chunk as Buffer).length;
        if (total > maxBytes) {
          res.body.destroy();
          throw new SsrfError(`Response size exceeds cap (${maxBytes} bytes)`);
        }
        chunks.push(chunk as Buffer);
      }
      // Body is fully buffered above; safe to close the agent in `finally` now.
      return {
        status: res.statusCode,
        contentType,
        body: Buffer.concat(chunks).toString("utf8"),
        finalUrl: url.toString(),
      };
    } finally {
      await agent.close();
    }
  }
  throw new SsrfError("Unreachable");
}
