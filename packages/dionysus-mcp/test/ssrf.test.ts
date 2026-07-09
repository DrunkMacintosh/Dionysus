import { describe, it, expect } from "vitest";
import { isPrivateIp, assertPublicHost, SsrfError } from "../src/lib/ssrf.js";

describe("isPrivateIp", () => {
  const blocked = [
    "127.0.0.1", "10.0.0.1", "172.16.0.1", "172.31.255.255",
    "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1",
    "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.5",
  ];
  const allowed = ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111"];

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
