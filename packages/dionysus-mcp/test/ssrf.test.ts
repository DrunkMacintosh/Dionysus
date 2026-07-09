import { describe, it, expect } from "vitest";
import { isPrivateIp, assertPublicHost, SsrfError } from "../src/lib/ssrf.js";

describe("isPrivateIp", () => {
  const blocked = [
    "127.0.0.1", "10.0.0.1", "172.16.0.1", "172.31.255.255",
    "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1",
    "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.5",
    "::ffff:7f00:1", "::ffff:a9fe:a9fe", "::ffff:a00:5", "::127.0.0.1", "::ffff:c0a8:1",
    // NAT64 (64:ff9b::/96) embedding private/metadata IPv4 — reachable on
    // IPv6-only / NAT64 cloud subnets, must be blocked.
    "64:ff9b::a9fe:a9fe", // → 169.254.169.254 (cloud metadata)
    "64:ff9b::7f00:1",    // → 127.0.0.1 (loopback)
    // 6to4 (2002::/16) embedding metadata IPv4 in hextets 1-2.
    "2002:a9fe:a9fe::1",  // → embedded v4 169.254.169.254
  ];
  const allowed = [
    "8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111", "2001:db8::1",
    "64:ff9b::808:808", // NAT64 mapping of PUBLIC 8.8.8.8 — must stay allowed
  ];

  for (const ip of blocked) {
    it(`blocks ${ip}`, () => expect(isPrivateIp(ip)).toBe(true));
  }
  for (const ip of allowed) {
    it(`allows ${ip}`, () => expect(isPrivateIp(ip)).toBe(false));
  }
});

describe("assertPublicHost", () => {
  it("rejects a hostname resolving to a private address", async () => {
    const fakeLookup = async () => [{ address: "127.0.0.1", family: 4 }];
    await expect(assertPublicHost("evil.example", fakeLookup)).rejects.toBeInstanceOf(SsrfError);
  });

  it("rejects when ANY resolved address is private (rebinding defense)", async () => {
    const fakeLookup = async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ];
    await expect(assertPublicHost("mixed.example", fakeLookup)).rejects.toBeInstanceOf(SsrfError);
  });

  it("accepts a hostname resolving only to public addresses", async () => {
    const fakeLookup = async () => [{ address: "8.8.8.8", family: 4 }];
    await expect(assertPublicHost("ok.example", fakeLookup)).resolves.toBeUndefined();
  });

  it("rejects IP literals that are private, without DNS", async () => {
    await expect(assertPublicHost("192.168.0.10")).rejects.toBeInstanceOf(SsrfError);
  });
});
